use crate::core::sftp::transfer::{
    TransferControlState, TransferController, register_transfer, unregister_transfer,
};
use ironrdp::client::rdp::RdpInputSender;
use ironrdp::cliprdr::backend::{
    ClipboardMessage, ClipboardMessageProxy, CliprdrBackend, CliprdrBackendFactory,
};
use ironrdp::cliprdr::is_windows_device_name;
use ironrdp::cliprdr::pdu::{
    ClipboardFileAttributes, ClipboardFormat, ClipboardFormatId, ClipboardGeneralCapabilityFlags,
    FORMAT_NAME_FILE_LIST, FileContentsFlags, FileContentsRequest, FileContentsResponse,
    FileDescriptor, FormatDataRequest, FormatDataResponse, LockDataId, OwnedFormatDataResponse,
};
use ironrdp::core::impl_as_any;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::fs::{self, File};
use std::hash::{Hash, Hasher};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter};

const MAX_CLIPBOARD_TEXT_BYTES: usize = 16 * 1024 * 1024;
const CLIPBOARD_POLL_INTERVAL: Duration = Duration::from_millis(750);
const CLIPBOARD_TIMEOUT: Duration = Duration::from_millis(1000);
const FILE_CHUNK_SIZE: u32 = 1024 * 1024;
const MAX_FILE_COUNT: usize = 100_000;
const REMOTE_TRANSFER_TIMEOUT: Duration = Duration::from_secs(60);
const CACHE_RETENTION: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Debug)]
struct LocalFileEntry {
    path: PathBuf,
    size: u64,
    is_directory: bool,
}

#[derive(Debug)]
struct LocalFileSnapshot {
    descriptors: Vec<FileDescriptor>,
    entries: Vec<LocalFileEntry>,
}

#[derive(Debug)]
struct RemoteFileSpec {
    descriptor_index: i32,
    path: PathBuf,
    expected_size: Option<u64>,
}

#[derive(Debug, Clone, Copy)]
enum PendingResponse {
    Size,
    Range { requested: u32 },
}

#[derive(Debug)]
struct ActiveRemoteFile {
    spec: RemoteFileSpec,
    file: File,
    offset: u64,
    pending: PendingResponse,
}

#[derive(Debug)]
struct RemoteGeneration {
    root: PathBuf,
    clipboard_paths: Vec<PathBuf>,
    pending_files: VecDeque<RemoteFileSpec>,
    active_files: HashMap<u32, ActiveRemoteFile>,
    controller: Arc<TransferController>,
    clip_data_id: Option<u32>,
    total_size: u64,
    transferred: u64,
    file_count: u64,
    completed_files: u64,
    last_activity: Instant,
}

#[derive(Debug)]
struct CompletedGeneration {
    root: PathBuf,
    file_list_hash: u64,
}

pub(crate) struct RdpClipboardBridge {
    app: AppHandle,
    pub(crate) session_id: String,
    file_enabled: bool,
    shutdown: AtomicBool,
    watcher_started: AtomicBool,
    proxy: Mutex<Option<Arc<Mutex<Box<dyn ClipboardMessageProxy>>>>>,
    last_text_hash: Mutex<Option<u64>>,
    last_file_hash: Mutex<Option<u64>>,
    current_snapshot: Mutex<Option<Arc<LocalFileSnapshot>>>,
    locked_snapshots: Mutex<HashMap<u32, Arc<LocalFileSnapshot>>>,
    remote_generation: Mutex<Option<RemoteGeneration>>,
    completed_generation: Mutex<Option<CompletedGeneration>>,
    next_stream_id: AtomicU32,
}

impl fmt::Debug for RdpClipboardBridge {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RdpClipboardBridge")
            .field("session_id", &self.session_id)
            .field("file_enabled", &self.file_enabled)
            .field("shutdown", &self.shutdown.load(Ordering::SeqCst))
            .finish_non_exhaustive()
    }
}

impl RdpClipboardBridge {
    pub(crate) fn new(app: AppHandle, session_id: String, file_enabled: bool) -> Self {
        let cache_root = clipboard_cache_root();
        let _ = cleanup_stale_cache(&cache_root, CACHE_RETENTION);
        Self {
            app,
            session_id,
            file_enabled,
            shutdown: AtomicBool::new(false),
            watcher_started: AtomicBool::new(false),
            proxy: Mutex::new(None),
            last_text_hash: Mutex::new(None),
            last_file_hash: Mutex::new(None),
            current_snapshot: Mutex::new(None),
            locked_snapshots: Mutex::new(HashMap::new()),
            remote_generation: Mutex::new(None),
            completed_generation: Mutex::new(None),
            next_stream_id: AtomicU32::new(1),
        }
    }

    fn set_proxy(&self, proxy: Arc<Mutex<Box<dyn ClipboardMessageProxy>>>) {
        if let Ok(mut current) = self.proxy.lock() {
            *current = Some(proxy);
        }
    }

    fn send(&self, message: ClipboardMessage) {
        let proxy = self.proxy.lock().ok().and_then(|proxy| proxy.clone());
        if let Some(proxy) = proxy
            && let Ok(proxy) = proxy.lock()
        {
            proxy.send_clipboard_message(message);
        }
    }

    pub(crate) fn notify_text_available(&self) -> Result<(), String> {
        if read_clipboard_text_blocking()
            .filter(|text| !text.is_empty() && clipboard_text_within_limit(text))
            .is_none()
        {
            return Ok(());
        }
        self.send(ClipboardMessage::SendInitiateCopy(vec![
            ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT),
        ]));
        Ok(())
    }

    fn advertise_current_clipboard(&self) {
        if self.file_enabled
            && let Some(paths) = read_clipboard_file_list_blocking()
            && !paths.is_empty()
        {
            let hash = file_list_fingerprint(&paths);
            let published_by_remote =
                self.completed_generation
                    .lock()
                    .ok()
                    .and_then(|generation| {
                        generation
                            .as_ref()
                            .map(|generation| generation.file_list_hash)
                    })
                    == Some(hash);
            if !published_by_remote {
                match build_local_snapshot(&paths) {
                    Ok(snapshot) => {
                        let snapshot = Arc::new(snapshot);
                        if let Ok(mut current) = self.current_snapshot.lock() {
                            *current = Some(snapshot.clone());
                        }
                        if let Ok(mut last) = self.last_file_hash.lock() {
                            *last = Some(hash);
                        }
                        self.send(ClipboardMessage::SendInitiateFileCopy(
                            snapshot.descriptors.clone(),
                        ));
                        return;
                    }
                    Err(error) => tracing::warn!(
                        session_id = %self.session_id,
                        %error,
                        "Unable to expose local clipboard files to RDP"
                    ),
                }
            }
        }
        let _ = self.notify_text_available();
    }

    pub(crate) fn start_watcher(self: &Arc<Self>) {
        if self.watcher_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let bridge = self.clone();
        std::thread::spawn(move || {
            while !bridge.shutdown.load(Ordering::SeqCst) {
                bridge.poll_local_clipboard();
                bridge.expire_remote_generation();
                std::thread::sleep(CLIPBOARD_POLL_INTERVAL);
            }
        });
    }

    fn poll_local_clipboard(&self) {
        if self.file_enabled
            && let Some(paths) = read_clipboard_file_list_blocking()
            && !paths.is_empty()
        {
            let hash = file_list_fingerprint(&paths);
            let published_hash = self
                .completed_generation
                .lock()
                .ok()
                .and_then(|generation| {
                    generation
                        .as_ref()
                        .map(|generation| generation.file_list_hash)
                });
            if published_hash == Some(hash) {
                if let Ok(mut last) = self.last_file_hash.lock() {
                    *last = Some(hash);
                }
                return;
            }

            self.release_completed_generation();
            let changed = self
                .last_file_hash
                .lock()
                .map(|mut last| {
                    let changed = *last != Some(hash);
                    *last = Some(hash);
                    changed
                })
                .unwrap_or(false);
            if changed {
                match build_local_snapshot(&paths) {
                    Ok(snapshot) => {
                        let snapshot = Arc::new(snapshot);
                        if let Ok(mut current) = self.current_snapshot.lock() {
                            *current = Some(snapshot.clone());
                        }
                        self.send(ClipboardMessage::SendInitiateFileCopy(
                            snapshot.descriptors.clone(),
                        ));
                    }
                    Err(error) => tracing::warn!(
                        session_id = %self.session_id,
                        %error,
                        "Ignoring unsafe local clipboard file list"
                    ),
                }
            }
            return;
        }

        self.release_completed_generation();
        if let Some(text) = read_clipboard_text_blocking()
            && clipboard_text_within_limit(&text)
        {
            let hash = stable_hash(&text);
            let changed = self
                .last_text_hash
                .lock()
                .map(|mut last| {
                    let changed = *last != Some(hash);
                    *last = Some(hash);
                    changed
                })
                .unwrap_or(false);
            if changed {
                self.send(ClipboardMessage::SendInitiateCopy(vec![
                    ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT),
                ]));
            }
        }
    }

    pub(crate) fn stop(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
        self.cancel_remote_generation("RDP clipboard disconnected", true);
        if let Ok(mut snapshots) = self.locked_snapshots.lock() {
            snapshots.clear();
        }
    }

    pub(crate) fn mark_text_written_from_remote(&self, text: &str) {
        if let Ok(mut last) = self.last_text_hash.lock() {
            *last = Some(stable_hash(&text));
        }
    }

    fn snapshot_for_request(
        &self,
        request: &FileContentsRequest,
    ) -> Option<Arc<LocalFileSnapshot>> {
        if let Some(data_id) = request.data_id {
            return self
                .locked_snapshots
                .lock()
                .ok()
                .and_then(|snapshots| snapshots.get(&data_id).cloned());
        }
        self.current_snapshot
            .lock()
            .ok()
            .and_then(|snapshot| snapshot.clone())
    }

    fn lock_snapshot(&self, data_id: LockDataId) {
        let current = self
            .current_snapshot
            .lock()
            .ok()
            .and_then(|snapshot| snapshot.clone());
        if let Some(current) = current
            && let Ok(mut snapshots) = self.locked_snapshots.lock()
        {
            snapshots.insert(data_id.0, current);
        }
    }

    fn unlock_snapshot(&self, data_id: LockDataId) {
        if let Ok(mut snapshots) = self.locked_snapshots.lock() {
            snapshots.remove(&data_id.0);
        }
    }

    fn begin_remote_generation(
        &self,
        files: &[FileDescriptor],
        clip_data_id: Option<u32>,
    ) -> Result<Vec<FileContentsRequest>, String> {
        self.cancel_remote_generation("Remote clipboard changed", true);
        let generation_id = uuid::Uuid::new_v4().to_string();
        let root = clipboard_cache_root().join(&generation_id);
        let prepared = prepare_remote_files(files, &root)?;
        if let Err(error) = fs::create_dir_all(&root) {
            let _ = fs::remove_dir_all(&root);
            return Err(format!("failed to create clipboard cache: {error}"));
        }
        for directory in &prepared.directories {
            if let Err(error) = fs::create_dir_all(directory) {
                let _ = fs::remove_dir_all(&root);
                return Err(format!("failed to create clipboard directory: {error}"));
            }
        }

        let file_count = u64::try_from(prepared.files.len()).unwrap_or(u64::MAX);
        let total_size = prepared
            .files
            .iter()
            .filter_map(|file| file.expected_size)
            .sum();
        let controller = Arc::new(TransferController::new_with_kind_and_source(
            generation_id,
            self.session_id.clone(),
            prepared.display_name,
            "RDP clipboard".to_string(),
            root.to_string_lossy().to_string(),
            "download".to_string(),
            if prepared.clipboard_paths.len() == 1 && prepared.files.len() == 1 {
                "file".to_string()
            } else {
                "directory".to_string()
            },
            None,
            Some(file_count),
            Some(0),
            Some("rdp".to_string()),
        ));
        controller.update_totals(total_size, file_count);
        register_transfer(controller.clone());
        let _ = self.app.emit(
            "transfer-event",
            &controller.build_event("started", 0, None),
        );

        let mut generation = RemoteGeneration {
            root,
            clipboard_paths: prepared.clipboard_paths,
            pending_files: prepared.files.into(),
            active_files: HashMap::new(),
            controller,
            clip_data_id,
            total_size,
            transferred: 0,
            file_count,
            completed_files: 0,
            last_activity: Instant::now(),
        };
        let requests = match self.pump_remote_generation(&mut generation) {
            Ok(requests) => requests,
            Err(error) => {
                self.fail_remote_generation(generation, &error);
                return Err(error);
            }
        };
        if generation.pending_files.is_empty() && generation.active_files.is_empty() {
            self.complete_remote_generation(generation)?;
        } else {
            match self.remote_generation.lock() {
                Ok(mut current) => *current = Some(generation),
                Err(_) => {
                    let error = "RDP clipboard generation lock is poisoned".to_string();
                    self.fail_remote_generation(generation, &error);
                    return Err(error);
                }
            }
        }
        Ok(requests)
    }

    fn pump_remote_generation(
        &self,
        generation: &mut RemoteGeneration,
    ) -> Result<Vec<FileContentsRequest>, String> {
        if generation.controller.control_state() == TransferControlState::Cancelled {
            return Err("RDP clipboard transfer cancelled".to_string());
        }
        let mut requests = Vec::new();
        while generation.active_files.len() < 2 {
            let Some(spec) = generation.pending_files.pop_front() else {
                break;
            };
            if let Some(parent) = spec.path.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    format!("failed to create clipboard parent directory: {error}")
                })?;
            }
            let file = File::create(&spec.path)
                .map_err(|error| format!("failed to create clipboard file: {error}"))?;
            if spec.expected_size == Some(0) {
                generation.completed_files = generation.completed_files.saturating_add(1);
                generation
                    .controller
                    .update_item_progress(generation.completed_files, generation.file_count);
                continue;
            }

            let stream_id = self.next_stream_id.fetch_add(1, Ordering::Relaxed);
            let (pending, request) = match spec.expected_size {
                Some(size) => {
                    let requested = u32::try_from(size.min(u64::from(FILE_CHUNK_SIZE)))
                        .unwrap_or(FILE_CHUNK_SIZE);
                    (
                        PendingResponse::Range { requested },
                        FileContentsRequest {
                            stream_id,
                            index: spec.descriptor_index,
                            flags: FileContentsFlags::RANGE,
                            position: 0,
                            requested_size: requested,
                            data_id: generation.clip_data_id,
                        },
                    )
                }
                None => (
                    PendingResponse::Size,
                    FileContentsRequest {
                        stream_id,
                        index: spec.descriptor_index,
                        flags: FileContentsFlags::SIZE,
                        position: 0,
                        requested_size: 8,
                        data_id: generation.clip_data_id,
                    },
                ),
            };
            generation.active_files.insert(
                stream_id,
                ActiveRemoteFile {
                    spec,
                    file,
                    offset: 0,
                    pending,
                },
            );
            requests.push(request);
        }
        Ok(requests)
    }

    fn handle_remote_response(
        &self,
        response: &FileContentsResponse<'_>,
    ) -> Result<Vec<FileContentsRequest>, String> {
        let mut current = self
            .remote_generation
            .lock()
            .map_err(|_| "RDP clipboard generation lock is poisoned".to_string())?;
        let Some(mut generation) = current.take() else {
            return Ok(Vec::new());
        };
        if generation.controller.control_state() == TransferControlState::Cancelled {
            cleanup_generation(&generation);
            unregister_transfer(&generation.controller.id());
            return Ok(Vec::new());
        }
        generation.last_activity = Instant::now();

        let result = (|| -> Result<Vec<FileContentsRequest>, String> {
            if response.is_error() {
                return Err("Remote rejected an RDP clipboard file request".to_string());
            }

            let stream_id = response.stream_id();
            let mut active = generation
                .active_files
                .remove(&stream_id)
                .ok_or_else(|| "Received an unknown RDP clipboard stream response".to_string())?;

            match active.pending {
                PendingResponse::Size => {
                    let size = response.data_as_size().map_err(|error| {
                        format!("invalid clipboard file size response: {error}")
                    })?;
                    active.spec.expected_size = Some(size);
                    generation.total_size = generation.total_size.saturating_add(size);
                    generation
                        .controller
                        .update_totals(generation.total_size, generation.file_count);
                }
                PendingResponse::Range { requested } => {
                    let data = response.data();
                    let expected_size = active
                        .spec
                        .expected_size
                        .ok_or_else(|| "clipboard file size is unknown".to_string())?;
                    if data.is_empty()
                        || data.len() > usize::try_from(requested).unwrap_or(usize::MAX)
                        || active
                            .offset
                            .saturating_add(u64::try_from(data.len()).unwrap_or(u64::MAX))
                            > expected_size
                    {
                        return Err("Remote returned an invalid clipboard file range".to_string());
                    }
                    active
                        .file
                        .write_all(data)
                        .map_err(|error| format!("failed to write clipboard cache: {error}"))?;
                    let written = u64::try_from(data.len()).unwrap_or(0);
                    active.offset = active.offset.saturating_add(written);
                    generation.transferred = generation.transferred.saturating_add(written);
                    generation
                        .controller
                        .update_progress(generation.transferred, generation.total_size);
                    let _ = self.app.emit(
                        "transfer-event",
                        &generation.controller.build_event("progress", 0, None),
                    );
                }
            }

            let expected_size = active.spec.expected_size.unwrap_or(0);
            let mut requests = Vec::new();
            if active.offset >= expected_size {
                active
                    .file
                    .flush()
                    .map_err(|error| format!("failed to flush clipboard cache: {error}"))?;
                generation.completed_files = generation.completed_files.saturating_add(1);
                generation
                    .controller
                    .update_item_progress(generation.completed_files, generation.file_count);
            } else {
                let remaining = expected_size.saturating_sub(active.offset);
                let requested = u32::try_from(remaining.min(u64::from(FILE_CHUNK_SIZE)))
                    .unwrap_or(FILE_CHUNK_SIZE);
                active.pending = PendingResponse::Range { requested };
                requests.push(FileContentsRequest {
                    stream_id,
                    index: active.spec.descriptor_index,
                    flags: FileContentsFlags::RANGE,
                    position: active.offset,
                    requested_size: requested,
                    data_id: generation.clip_data_id,
                });
                generation.active_files.insert(stream_id, active);
            }
            requests.extend(self.pump_remote_generation(&mut generation)?);
            Ok(requests)
        })();

        match result {
            Err(error) => {
                drop(current);
                self.fail_remote_generation(generation, &error);
                Err(error)
            }
            Ok(requests) => {
                if generation.pending_files.is_empty() && generation.active_files.is_empty() {
                    drop(current);
                    self.complete_remote_generation(generation)?;
                } else {
                    *current = Some(generation);
                }
                Ok(requests)
            }
        }
    }
    fn complete_remote_generation(&self, generation: RemoteGeneration) -> Result<(), String> {
        if generation.transferred != generation.total_size {
            let error = "RDP clipboard byte count did not match the declared size".to_string();
            self.fail_remote_generation(generation, &error);
            return Err(error);
        }
        if let Err(error) = write_clipboard_file_list_blocking(&generation.clipboard_paths) {
            self.fail_remote_generation(generation, &error);
            return Err(error);
        }
        let hash = file_list_fingerprint(&generation.clipboard_paths);
        if let Ok(mut last) = self.last_file_hash.lock() {
            *last = Some(hash);
        }
        self.release_completed_generation();
        if let Ok(mut completed) = self.completed_generation.lock() {
            *completed = Some(CompletedGeneration {
                root: generation.root.clone(),
                file_list_hash: hash,
            });
        }
        let _ = self.app.emit(
            "transfer-event",
            &generation
                .controller
                .build_event("completed", generation.total_size, None),
        );
        unregister_transfer(&generation.controller.id());
        Ok(())
    }

    fn fail_remote_generation(&self, generation: RemoteGeneration, error: &str) {
        cleanup_generation(&generation);
        let _ = self.app.emit(
            "transfer-event",
            &generation
                .controller
                .build_event("error", 0, Some(error.to_string())),
        );
        unregister_transfer(&generation.controller.id());
    }

    fn cancel_remote_generation(&self, reason: &str, emit: bool) {
        let generation = self
            .remote_generation
            .lock()
            .ok()
            .and_then(|mut generation| generation.take());
        if let Some(generation) = generation {
            cleanup_generation(&generation);
            if emit && generation.controller.control_state() != TransferControlState::Cancelled {
                let _ = self.app.emit(
                    "transfer-event",
                    &generation
                        .controller
                        .build_event("cancelled", 0, Some(reason.to_string())),
                );
            }
            unregister_transfer(&generation.controller.id());
        }
    }

    fn expire_remote_generation(&self) {
        let expired = self
            .remote_generation
            .lock()
            .ok()
            .and_then(|generation| {
                generation.as_ref().map(|generation| {
                    generation.controller.control_state() == TransferControlState::Cancelled
                        || generation.last_activity.elapsed() >= REMOTE_TRANSFER_TIMEOUT
                })
            })
            .unwrap_or(false);
        if expired {
            self.cancel_remote_generation(
                "RDP clipboard transfer timed out or was cancelled",
                true,
            );
        }
    }

    fn release_completed_generation(&self) {
        let completed = self
            .completed_generation
            .lock()
            .ok()
            .and_then(|mut generation| generation.take());
        if let Some(completed) = completed {
            let _ = fs::remove_dir_all(completed.root);
        }
    }

    fn cancel_for_locks(&self, locks: &[LockDataId]) {
        let should_cancel = self
            .remote_generation
            .lock()
            .ok()
            .and_then(|generation| {
                generation
                    .as_ref()
                    .and_then(|generation| generation.clip_data_id)
            })
            .is_some_and(|id| locks.iter().any(|lock| lock.0 == id));
        if should_cancel {
            self.cancel_remote_generation("RDP clipboard lock expired", true);
        }
    }
}

pub(crate) struct RdpClipboardBackendFactory {
    bridge: Arc<RdpClipboardBridge>,
    proxy: Arc<Mutex<Box<dyn ClipboardMessageProxy>>>,
}

impl RdpClipboardBackendFactory {
    pub(crate) fn new(
        bridge: Arc<RdpClipboardBridge>,
        proxy: Box<dyn ClipboardMessageProxy>,
    ) -> Self {
        let proxy = Arc::new(Mutex::new(proxy));
        bridge.set_proxy(proxy.clone());
        Self { bridge, proxy }
    }

    pub(crate) fn from_input_sender(
        bridge: Arc<RdpClipboardBridge>,
        input_sender: RdpInputSender,
    ) -> Self {
        Self::new(bridge, Box::new(RdpClipboardMessageProxy { input_sender }))
    }
}

#[derive(Debug)]
struct RdpClipboardMessageProxy {
    input_sender: RdpInputSender,
}

impl ClipboardMessageProxy for RdpClipboardMessageProxy {
    fn send_clipboard_message(&self, message: ClipboardMessage) {
        if self.input_sender.send_clipboard(message).is_err() {
            tracing::debug!("RDP clipboard channel is closed");
        }
    }
}

impl CliprdrBackendFactory for RdpClipboardBackendFactory {
    fn build_cliprdr_backend(&self) -> Box<dyn CliprdrBackend> {
        Box::new(RdpClipboardBackend {
            bridge: self.bridge.clone(),
            proxy: self.proxy.clone(),
            negotiated_capabilities: ClipboardGeneralCapabilityFlags::empty(),
        })
    }
}

struct RdpClipboardBackend {
    bridge: Arc<RdpClipboardBridge>,
    proxy: Arc<Mutex<Box<dyn ClipboardMessageProxy>>>,
    negotiated_capabilities: ClipboardGeneralCapabilityFlags,
}

impl fmt::Debug for RdpClipboardBackend {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RdpClipboardBackend")
            .field("session_id", &self.bridge.session_id)
            .field("negotiated_capabilities", &self.negotiated_capabilities)
            .finish()
    }
}

impl_as_any!(RdpClipboardBackend);

impl RdpClipboardBackend {
    fn send(&self, message: ClipboardMessage) {
        if let Ok(proxy) = self.proxy.lock() {
            proxy.send_clipboard_message(message);
        }
    }
}

impl CliprdrBackend for RdpClipboardBackend {
    fn temporary_directory(&self) -> &str {
        ".nyaterm-rdp-cliprdr"
    }

    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        let mut capabilities = ClipboardGeneralCapabilityFlags::USE_LONG_FORMAT_NAMES;
        if self.bridge.file_enabled {
            capabilities |= ClipboardGeneralCapabilityFlags::STREAM_FILECLIP_ENABLED
                | ClipboardGeneralCapabilityFlags::FILECLIP_NO_FILE_PATHS
                | ClipboardGeneralCapabilityFlags::CAN_LOCK_CLIPDATA;
        }
        capabilities
    }

    fn on_ready(&mut self) {
        self.bridge.start_watcher();
        self.bridge.advertise_current_clipboard();
    }

    fn on_request_format_list(&mut self) {
        self.bridge.advertise_current_clipboard();
    }

    fn on_process_negotiated_capabilities(
        &mut self,
        capabilities: ClipboardGeneralCapabilityFlags,
    ) {
        self.negotiated_capabilities = capabilities;
    }

    fn on_remote_copy(&mut self, available_formats: &[ClipboardFormat]) {
        self.bridge
            .cancel_remote_generation("Remote clipboard changed", true);
        let file_format = self.bridge.file_enabled.then(|| {
            available_formats.iter().find(|format| {
                format
                    .name
                    .as_ref()
                    .is_some_and(|name| name.value() == FORMAT_NAME_FILE_LIST)
            })
        });
        if let Some(Some(format)) = file_format {
            self.send(ClipboardMessage::SendInitiatePaste(format.id));
        } else if available_formats
            .iter()
            .any(|format| format.id == ClipboardFormatId::CF_UNICODETEXT)
        {
            self.send(ClipboardMessage::SendInitiatePaste(
                ClipboardFormatId::CF_UNICODETEXT,
            ));
        }
    }

    fn on_format_data_request(&mut self, request: FormatDataRequest) {
        if request.format != ClipboardFormatId::CF_UNICODETEXT {
            self.send(ClipboardMessage::SendFormatData(
                OwnedFormatDataResponse::new_error(),
            ));
            return;
        }
        let response = match read_clipboard_text_blocking() {
            Some(text) if clipboard_text_within_limit(&text) => {
                OwnedFormatDataResponse::new_unicode_string(&text)
            }
            _ => OwnedFormatDataResponse::new_error(),
        };
        self.send(ClipboardMessage::SendFormatData(response));
    }

    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        if response.is_error() {
            return;
        }
        let Ok(text) = response.to_unicode_string() else {
            return;
        };
        if !clipboard_text_within_limit(&text) {
            tracing::warn!(session_id = %self.bridge.session_id, "Ignoring oversized RDP clipboard text");
            return;
        }
        self.bridge.mark_text_written_from_remote(&text);
        std::thread::spawn(move || {
            let _ = write_clipboard_text_blocking(text);
        });
    }

    fn on_file_contents_request(&mut self, request: FileContentsRequest) {
        let response = serve_local_file_request(&self.bridge, &request)
            .unwrap_or_else(|_| FileContentsResponse::new_error(request.stream_id));
        self.send(ClipboardMessage::SendFileContentsResponse(response));
    }

    fn on_file_contents_response(&mut self, response: FileContentsResponse<'_>) {
        match self.bridge.handle_remote_response(&response) {
            Ok(requests) => {
                for request in requests {
                    self.send(ClipboardMessage::SendFileContentsRequest(request));
                }
            }
            Err(error) => {
                tracing::warn!(session_id = %self.bridge.session_id, %error, "RDP clipboard download failed")
            }
        }
    }

    fn on_lock(&mut self, data_id: LockDataId) {
        self.bridge.lock_snapshot(data_id);
    }

    fn on_unlock(&mut self, data_id: LockDataId) {
        self.bridge.unlock_snapshot(data_id);
    }

    fn on_remote_file_list(&mut self, files: &[FileDescriptor], clip_data_id: Option<u32>) {
        match self.bridge.begin_remote_generation(files, clip_data_id) {
            Ok(requests) => {
                for request in requests {
                    self.send(ClipboardMessage::SendFileContentsRequest(request));
                }
            }
            Err(error) => {
                tracing::warn!(session_id = %self.bridge.session_id, %error, "Rejected RDP clipboard file list")
            }
        }
    }

    fn on_outgoing_locks_expired(&mut self, clip_data_ids: &[LockDataId]) {
        self.bridge.cancel_for_locks(clip_data_ids);
    }

    fn on_outgoing_locks_cleared(&mut self, clip_data_ids: &[LockDataId]) {
        self.bridge.cancel_for_locks(clip_data_ids);
    }
}

struct PreparedRemoteFiles {
    display_name: String,
    directories: Vec<PathBuf>,
    files: Vec<RemoteFileSpec>,
    clipboard_paths: Vec<PathBuf>,
}

fn prepare_remote_files(
    files: &[FileDescriptor],
    root: &Path,
) -> Result<PreparedRemoteFiles, String> {
    if files.is_empty() || files.len() > MAX_FILE_COUNT {
        return Err("remote clipboard file count is invalid".to_string());
    }
    let mut seen = HashSet::new();
    let mut directories = Vec::new();
    let mut regular_files = Vec::new();
    let mut top_level = HashSet::new();

    for (index, descriptor) in files.iter().enumerate() {
        let relative = descriptor_relative_path(descriptor)?;
        let collision_key = relative.to_string_lossy().to_lowercase();
        if !seen.insert(collision_key) {
            return Err("remote clipboard contains duplicate paths".to_string());
        }
        if let Some(Component::Normal(component)) = relative.components().next() {
            top_level.insert(component.to_os_string());
        }
        let target = root.join(&relative);
        if descriptor
            .attributes
            .is_some_and(|attributes| attributes.contains(ClipboardFileAttributes::DIRECTORY))
        {
            directories.push(target);
        } else {
            regular_files.push(RemoteFileSpec {
                descriptor_index: i32::try_from(index)
                    .map_err(|_| "remote clipboard index is too large".to_string())?,
                path: target,
                expected_size: descriptor.file_size,
            });
        }
    }
    directories.sort_by_key(|path| path.components().count());
    let mut top_level = top_level.into_iter().collect::<Vec<_>>();
    top_level.sort();
    let clipboard_paths = top_level
        .iter()
        .map(|name| root.join(name))
        .collect::<Vec<_>>();
    let display_name = if clipboard_paths.len() == 1 {
        clipboard_paths[0]
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("RDP clipboard files")
            .to_string()
    } else {
        format!("{} RDP clipboard items", clipboard_paths.len())
    };
    Ok(PreparedRemoteFiles {
        display_name,
        directories,
        files: regular_files,
        clipboard_paths,
    })
}

fn descriptor_relative_path(descriptor: &FileDescriptor) -> Result<PathBuf, String> {
    let mut result = PathBuf::new();
    let mut parts = Vec::new();
    if let Some(parent) = descriptor.relative_path.as_deref() {
        parts.extend(parent.split(['/', '\\']));
    }
    parts.push(&descriptor.name);
    for part in parts {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.contains('\0')
            || part.contains(':')
            || part.ends_with([' ', '.'])
            || is_windows_device_name(part)
        {
            return Err(format!("unsafe remote clipboard path component: {part}"));
        }
        result.push(part);
    }
    if result.is_absolute()
        || result
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("remote clipboard path is not relative".to_string());
    }
    Ok(result)
}

fn build_local_snapshot(paths: &[PathBuf]) -> Result<LocalFileSnapshot, String> {
    if paths.is_empty() || paths.len() > MAX_FILE_COUNT {
        return Err("local clipboard file count is invalid".to_string());
    }
    let mut descriptors = Vec::new();
    let mut entries = Vec::new();
    let mut names = HashSet::new();
    for selected in paths {
        let selected_metadata = fs::symlink_metadata(selected)
            .map_err(|error| format!("failed to inspect clipboard path: {error}"))?;
        if selected_metadata.file_type().is_symlink() {
            return Err("symbolic links are not exposed through RDP clipboard".to_string());
        }
        let canonical = selected
            .canonicalize()
            .map_err(|error| format!("failed to resolve clipboard path: {error}"))?;
        let name = selected
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "clipboard path has no valid file name".to_string())?;
        if !names.insert(name.to_lowercase()) {
            return Err("local clipboard contains duplicate root names".to_string());
        }
        append_local_entry(&canonical, Path::new(name), &mut descriptors, &mut entries)?;
    }
    Ok(LocalFileSnapshot {
        descriptors,
        entries,
    })
}

fn append_local_entry(
    path: &Path,
    relative: &Path,
    descriptors: &mut Vec<FileDescriptor>,
    entries: &mut Vec<LocalFileEntry>,
) -> Result<(), String> {
    if descriptors.len() >= MAX_FILE_COUNT {
        return Err("local clipboard contains too many files".to_string());
    }
    let symlink_metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect clipboard file: {error}"))?;
    if symlink_metadata.file_type().is_symlink() {
        return Err("symbolic links are not exposed through RDP clipboard".to_string());
    }
    let metadata =
        fs::metadata(path).map_err(|error| format!("failed to inspect clipboard file: {error}"))?;
    if !metadata.is_file() && !metadata.is_dir() {
        return Err("special files are not exposed through RDP clipboard".to_string());
    }
    let name = relative
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "clipboard file name is not valid UTF-8".to_string())?;
    let parent = relative
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty());
    let parent_wire = parent.map(path_to_wire).transpose()?;
    let wire_len = relative.to_string_lossy().encode_utf16().count() + 1;
    if wire_len > 260 {
        return Err("clipboard relative path exceeds the RDP limit".to_string());
    }
    let is_directory = metadata.is_dir();
    let size = if is_directory { 0 } else { metadata.len() };
    let mut descriptor = FileDescriptor::new(name).with_attributes(if is_directory {
        ClipboardFileAttributes::DIRECTORY
    } else {
        ClipboardFileAttributes::NORMAL | ClipboardFileAttributes::ARCHIVE
    });
    if !is_directory {
        descriptor = descriptor.with_file_size(size);
    }
    if let Some(parent) = parent_wire {
        descriptor = descriptor.with_relative_path(parent);
    }
    descriptors.push(descriptor);
    entries.push(LocalFileEntry {
        path: path.to_path_buf(),
        size,
        is_directory,
    });
    if is_directory {
        let mut children = fs::read_dir(path)
            .map_err(|error| format!("failed to read clipboard directory: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("failed to read clipboard directory: {error}"))?;
        children.sort_by_key(|entry| entry.file_name());
        for child in children {
            append_local_entry(
                &child.path(),
                &relative.join(child.file_name()),
                descriptors,
                entries,
            )?;
        }
    }
    Ok(())
}

fn path_to_wire(path: &Path) -> Result<String, String> {
    path.components()
        .map(|component| match component {
            Component::Normal(value) => value
                .to_str()
                .map(ToOwned::to_owned)
                .ok_or_else(|| "clipboard path is not valid UTF-8".to_string()),
            _ => Err("clipboard path is not relative".to_string()),
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|parts| parts.join("\\"))
}

fn serve_local_file_request(
    bridge: &RdpClipboardBridge,
    request: &FileContentsRequest,
) -> Result<FileContentsResponse<'static>, String> {
    request.flags.validate().map_err(str::to_string)?;
    let snapshot = bridge
        .snapshot_for_request(request)
        .ok_or_else(|| "clipboard snapshot is no longer available".to_string())?;
    serve_snapshot_file_request(&snapshot, request)
}

fn serve_snapshot_file_request(
    snapshot: &LocalFileSnapshot,
    request: &FileContentsRequest,
) -> Result<FileContentsResponse<'static>, String> {
    let index = usize::try_from(request.index).map_err(|_| "invalid file index".to_string())?;
    let entry = snapshot
        .entries
        .get(index)
        .ok_or_else(|| "file index is outside the clipboard snapshot".to_string())?;
    if request.flags.contains(FileContentsFlags::SIZE) {
        if request.position != 0 || request.requested_size != 8 {
            return Err("invalid clipboard SIZE request".to_string());
        }
        return Ok(FileContentsResponse::new_size_response(
            request.stream_id,
            entry.size,
        ));
    }
    if entry.is_directory
        || request.requested_size == 0
        || request.requested_size > FILE_CHUNK_SIZE
        || request.position > entry.size
    {
        return Err("invalid clipboard RANGE request".to_string());
    }
    let remaining = entry.size.saturating_sub(request.position);
    let read_size = usize::try_from(remaining.min(u64::from(request.requested_size)))
        .map_err(|_| "clipboard range is too large".to_string())?;
    let mut file = File::open(&entry.path)
        .map_err(|error| format!("failed to open clipboard file: {error}"))?;
    file.seek(SeekFrom::Start(request.position))
        .map_err(|error| format!("failed to seek clipboard file: {error}"))?;
    let mut data = vec![0_u8; read_size];
    file.read_exact(&mut data)
        .map_err(|error| format!("failed to read clipboard file: {error}"))?;
    Ok(FileContentsResponse::new_data_response(
        request.stream_id,
        data,
    ))
}

fn cleanup_generation(generation: &RemoteGeneration) {
    let _ = fs::remove_dir_all(&generation.root);
}

fn clipboard_cache_root() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("nyaterm")
        .join("rdp-clipboard")
}

fn cleanup_stale_cache(root: &Path, retention: Duration) -> Result<(), String> {
    let Ok(entries) = fs::read_dir(root) else {
        return Ok(());
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= retention);
        if stale {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
    Ok(())
}

fn read_clipboard_text_blocking() -> Option<String> {
    let start = Instant::now();
    let mut clipboard = arboard::Clipboard::new().ok()?;
    if start.elapsed() > CLIPBOARD_TIMEOUT {
        return None;
    }
    clipboard.get_text().ok()
}

pub(crate) fn write_clipboard_text_blocking(text: String) -> Result<(), String> {
    let start = Instant::now();
    let mut clipboard =
        arboard::Clipboard::new().map_err(|error| format!("failed to open clipboard: {error}"))?;
    if start.elapsed() > CLIPBOARD_TIMEOUT {
        return Err("clipboard write timed out".to_string());
    }
    clipboard
        .set_text(text)
        .map_err(|error| format!("failed to write clipboard text: {error}"))
}

fn read_clipboard_file_list_blocking() -> Option<Vec<PathBuf>> {
    let start = Instant::now();
    let mut clipboard = arboard::Clipboard::new().ok()?;
    if start.elapsed() > CLIPBOARD_TIMEOUT {
        return None;
    }
    clipboard.get().file_list().ok()
}

fn write_clipboard_file_list_blocking(paths: &[PathBuf]) -> Result<(), String> {
    let start = Instant::now();
    let mut clipboard =
        arboard::Clipboard::new().map_err(|error| format!("failed to open clipboard: {error}"))?;
    if start.elapsed() > CLIPBOARD_TIMEOUT {
        return Err("clipboard write timed out".to_string());
    }
    clipboard
        .set()
        .file_list(paths)
        .map_err(|error| format!("failed to publish clipboard files: {error}"))
}

fn clipboard_text_within_limit(text: &str) -> bool {
    text.len() <= MAX_CLIPBOARD_TEXT_BYTES
}

fn stable_hash<T: Hash + ?Sized>(value: &T) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

fn file_list_fingerprint(paths: &[PathBuf]) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for path in paths {
        path.hash(&mut hasher);
        if let Ok(metadata) = fs::metadata(path) {
            metadata.len().hash(&mut hasher);
            metadata.is_dir().hash(&mut hasher);
            metadata.modified().ok().hash(&mut hasher);
        }
    }
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipboard_limit_rejects_oversized_text() {
        let oversized = "x".repeat(MAX_CLIPBOARD_TEXT_BYTES + 1);
        assert!(clipboard_text_within_limit(""));
        assert!(clipboard_text_within_limit("hello"));
        assert!(!clipboard_text_within_limit(&oversized));
    }

    #[test]
    fn stable_hash_supports_text_loop_prevention_tokens() {
        assert_eq!(stable_hash("same"), stable_hash("same"));
        assert_ne!(stable_hash("same"), stable_hash("different"));
    }

    #[test]
    fn rejects_unsafe_remote_paths() {
        let mut descriptor = FileDescriptor::new("secret.txt");
        descriptor.relative_path = Some("..\\outside".to_string());
        assert!(descriptor_relative_path(&descriptor).is_err());

        assert!(descriptor_relative_path(&FileDescriptor::new("CON.txt")).is_err());
        assert!(descriptor_relative_path(&FileDescriptor::new("safe.txt")).is_ok());
    }

    #[test]
    fn local_range_read_is_bounded() {
        let dir = std::env::temp_dir().join(format!("nyaterm-rdp-clip-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sample.bin");
        fs::write(&path, b"abcdefgh").unwrap();
        let snapshot = build_local_snapshot(std::slice::from_ref(&path)).unwrap();
        assert_eq!(snapshot.entries[0].size, 8);
        assert_eq!(snapshot.descriptors[0].file_size, Some(8));
        assert!(snapshot.descriptors[0].relative_path.is_none());

        let response = serve_snapshot_file_request(
            &snapshot,
            &FileContentsRequest {
                stream_id: 7,
                index: 0,
                flags: FileContentsFlags::RANGE,
                position: 2,
                requested_size: 3,
                data_id: None,
            },
        )
        .unwrap();
        assert_eq!(response.data(), b"cde");

        let oversized = serve_snapshot_file_request(
            &snapshot,
            &FileContentsRequest {
                stream_id: 8,
                index: 0,
                flags: FileContentsFlags::RANGE,
                position: 0,
                requested_size: FILE_CHUNK_SIZE + 1,
                data_id: None,
            },
        );
        assert!(oversized.is_err());

        let out_of_bounds = serve_snapshot_file_request(
            &snapshot,
            &FileContentsRequest {
                stream_id: 9,
                index: 0,
                flags: FileContentsFlags::RANGE,
                position: 9,
                requested_size: 1,
                data_id: None,
            },
        );
        assert!(out_of_bounds.is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn local_directory_snapshot_preserves_tree_descriptors() {
        let root = std::env::temp_dir().join(format!("nyaterm-rdp-tree-{}", uuid::Uuid::new_v4()));
        let selected = root.join("folder");
        let nested = selected.join("nested");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("hello.txt"), b"hello").unwrap();

        let snapshot = build_local_snapshot(std::slice::from_ref(&selected)).unwrap();
        assert_eq!(snapshot.descriptors.len(), 3);
        assert_eq!(snapshot.descriptors[0].name, "folder");
        assert_eq!(snapshot.descriptors[1].name, "nested");
        assert_eq!(
            snapshot.descriptors[1].relative_path.as_deref(),
            Some("folder")
        );
        assert_eq!(snapshot.descriptors[2].name, "hello.txt");
        assert_eq!(
            snapshot.descriptors[2].relative_path.as_deref(),
            Some("folder\\nested")
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn remote_file_list_rejects_duplicate_paths() {
        let root =
            std::env::temp_dir().join(format!("nyaterm-rdp-remote-{}", uuid::Uuid::new_v4()));
        let first = FileDescriptor::new("Report.txt").with_file_size(1);
        let second = FileDescriptor::new("report.TXT").with_file_size(1);

        let result = prepare_remote_files(&[first, second], &root);
        assert!(result.is_err());
        assert!(!root.exists());
    }

    #[test]
    fn stale_cache_cleanup_removes_only_old_generations() {
        let root = std::env::temp_dir().join(format!("nyaterm-rdp-cache-{}", uuid::Uuid::new_v4()));
        let fresh = root.join("fresh");
        fs::create_dir_all(&fresh).unwrap();
        cleanup_stale_cache(&root, Duration::from_secs(60)).unwrap();
        assert!(fresh.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
