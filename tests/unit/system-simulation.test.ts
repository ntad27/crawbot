/**
 * System Simulation Tests
 * End-to-end simulation of CrawBot's core subsystems:
 * - Gateway protocol (JSON-RPC message handling)
 * - File type detection & workspace view modes
 * - Provider registry & configuration
 * - Store state management (providers, file browser, channels, settings)
 * - Provider lifecycle (add → configure → validate → set default)
 * - File browser workflow (open panel → navigate → select → edit → save)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/* ── Protocol ── */
import {
  createRequest,
  createSuccessResponse,
  createErrorResponse,
  isRequest,
  isResponse,
  isNotification,
  JsonRpcErrorCode,
  GatewayErrorCode,
  GatewayEventType,
} from '@electron/gateway/protocol';

/* ── File type utils ── */
import {
  extractFilePath,
  getMimeType,
  getFileViewMode,
  getFileTypeLabel,
  detectFileCategory,
  extToLanguage,
} from '@/utils/file-type';

/* ── Provider registry (backend) ── */
import {
  getProviderEnvVar,
  getProviderDefaultModel,
  getProviderConfig,
  getKeyableProviderTypes,
  BUILTIN_PROVIDER_TYPES,
} from '@electron/utils/provider-registry';

/* ── Provider UI metadata (frontend) ── */
import {
  PROVIDER_TYPE_INFO,
  getProviderTypeInfo,
  shouldInvertInDark,
} from '@/lib/providers';

/* ── Utils ── */
import { formatRelativeTime, formatDuration, truncate, delay } from '@/lib/utils';

/* ── Stores ── */
import { useSettingsStore } from '@/stores/settings';
import { useGatewayStore } from '@/stores/gateway';
import { useProviderStore } from '@/stores/providers';
import { useFileBrowserStore } from '@/stores/file-browser';
import { useChannelsStore } from '@/stores/channels';

// ─────────────────────────────────────────────────────────────────
// 1. Gateway Protocol — JSON-RPC 2.0 Message Handling
// ─────────────────────────────────────────────────────────────────

describe('Gateway Protocol', () => {
  describe('createRequest', () => {
    it('should create a valid JSON-RPC request with auto-generated id', () => {
      const req = createRequest('chat.send', { text: 'hello' });
      expect(req.jsonrpc).toBe('2.0');
      expect(req.method).toBe('chat.send');
      expect(req.params).toEqual({ text: 'hello' });
      expect(req.id).toBeDefined();
    });

    it('should accept a custom id', () => {
      const req = createRequest('agents.list', undefined, 42);
      expect(req.id).toBe(42);
      expect(req.params).toBeUndefined();
    });
  });

  describe('createSuccessResponse', () => {
    it('should wrap result in JSON-RPC response', () => {
      const res = createSuccessResponse('req-1', { agents: ['main'] });
      expect(res.jsonrpc).toBe('2.0');
      expect(res.id).toBe('req-1');
      expect(res.result).toEqual({ agents: ['main'] });
      expect(res.error).toBeUndefined();
    });
  });

  describe('createErrorResponse', () => {
    it('should create error with code, message, and optional data', () => {
      const res = createErrorResponse(
        'req-2',
        JsonRpcErrorCode.METHOD_NOT_FOUND,
        'Method not found',
        { tried: 'foo.bar' },
      );
      expect(res.error?.code).toBe(-32601);
      expect(res.error?.message).toBe('Method not found');
      expect(res.error?.data).toEqual({ tried: 'foo.bar' });
    });
  });

  describe('type guards', () => {
    it('isRequest identifies valid request', () => {
      expect(isRequest({ jsonrpc: '2.0', id: 1, method: 'ping' })).toBe(true);
    });

    it('isRequest rejects notification (no id)', () => {
      expect(isRequest({ jsonrpc: '2.0', method: 'ping' })).toBe(false);
    });

    it('isResponse identifies success response', () => {
      expect(isResponse({ jsonrpc: '2.0', id: 1, result: 'pong' })).toBe(true);
    });

    it('isResponse identifies error response', () => {
      expect(
        isResponse({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'err' } }),
      ).toBe(true);
    });

    it('isResponse rejects request', () => {
      expect(isResponse({ jsonrpc: '2.0', id: 1, method: 'ping' })).toBe(false);
    });

    it('isNotification identifies notification', () => {
      expect(isNotification({ jsonrpc: '2.0', method: 'event.tick' })).toBe(true);
    });

    it('isNotification rejects request (has id)', () => {
      expect(isNotification({ jsonrpc: '2.0', id: 1, method: 'ping' })).toBe(false);
    });

    it('all guards reject non-objects', () => {
      expect(isRequest(null)).toBe(false);
      expect(isResponse('string')).toBe(false);
      expect(isNotification(42)).toBe(false);
    });
  });

  describe('error code enums', () => {
    it('JSON-RPC standard error codes', () => {
      expect(JsonRpcErrorCode.PARSE_ERROR).toBe(-32700);
      expect(JsonRpcErrorCode.INVALID_REQUEST).toBe(-32600);
      expect(JsonRpcErrorCode.INTERNAL_ERROR).toBe(-32603);
    });

    it('Gateway-specific error codes', () => {
      expect(GatewayErrorCode.NOT_CONNECTED).toBe(-32001);
      expect(GatewayErrorCode.AUTH_REQUIRED).toBe(-32002);
      expect(GatewayErrorCode.TIMEOUT).toBe(-32005);
    });
  });

  describe('event type enums', () => {
    it('has expected event types', () => {
      expect(GatewayEventType.STATUS_CHANGED).toBe('gateway.status_changed');
      expect(GatewayEventType.MESSAGE_RECEIVED).toBe('chat.message_received');
      expect(GatewayEventType.TOOL_CALL_STARTED).toBe('tool.call_started');
    });
  });

  describe('simulated RPC round-trip', () => {
    it('should simulate a full request → success response cycle', () => {
      // Client sends request
      const req = createRequest('agents.list', {}, 'rpc-1');
      expect(isRequest(req)).toBe(true);

      // Server responds
      const res = createSuccessResponse(req.id, { agents: ['main', 'research'] });
      expect(isResponse(res)).toBe(true);
      expect(res.id).toBe(req.id);
      expect(res.result).toEqual({ agents: ['main', 'research'] });
    });

    it('should simulate a request → error response cycle', () => {
      const req = createRequest('provider.unknown', {}, 'rpc-2');
      const res = createErrorResponse(
        req.id,
        GatewayErrorCode.NOT_FOUND,
        'Provider not found',
      );
      expect(isResponse(res)).toBe(true);
      expect(res.error?.code).toBe(GatewayErrorCode.NOT_FOUND);
    });
  });
});

// ─────────────────────────────────────────────────────────────────
// 2. File Type Detection & Workspace Modes
// ─────────────────────────────────────────────────────────────────

describe('File Type System', () => {
  describe('extractFilePath', () => {
    it('extracts from file_path arg', () => {
      expect(extractFilePath({ file_path: '/src/main.ts' })).toBe('/src/main.ts');
    });

    it('extracts from filePath arg', () => {
      expect(extractFilePath({ filePath: '/app.tsx' })).toBe('/app.tsx');
    });

    it('extracts from path arg', () => {
      expect(extractFilePath({ path: '/README.md' })).toBe('/README.md');
    });

    it('returns undefined for non-object', () => {
      expect(extractFilePath(null)).toBeUndefined();
      expect(extractFilePath('string')).toBeUndefined();
    });

    it('returns undefined when no matching key', () => {
      expect(extractFilePath({ name: 'test' })).toBeUndefined();
    });
  });

  describe('getMimeType', () => {
    it('maps common image types', () => {
      expect(getMimeType('photo.png')).toBe('image/png');
      expect(getMimeType('photo.jpg')).toBe('image/jpeg');
      expect(getMimeType('icon.svg')).toBe('image/svg+xml');
    });

    it('maps audio types', () => {
      expect(getMimeType('song.mp3')).toBe('audio/mpeg');
      expect(getMimeType('track.wav')).toBe('audio/wav');
    });

    it('maps video types', () => {
      expect(getMimeType('clip.mp4')).toBe('video/mp4');
      expect(getMimeType('stream.webm')).toBe('video/webm');
    });

    it('maps pdf', () => {
      expect(getMimeType('doc.pdf')).toBe('application/pdf');
    });

    it('returns undefined for unknown extension', () => {
      expect(getMimeType('file.xyz')).toBeUndefined();
      expect(getMimeType('Makefile')).toBeUndefined();
    });
  });

  describe('getFileViewMode', () => {
    it('images → image mode', () => {
      expect(getFileViewMode('photo.png')).toBe('image');
      expect(getFileViewMode('bg.webp')).toBe('image');
      expect(getFileViewMode('icon.svg')).toBe('image');
    });

    it('pdf → pdf mode', () => {
      expect(getFileViewMode('report.pdf')).toBe('pdf');
    });

    it('audio → audio mode', () => {
      expect(getFileViewMode('song.mp3')).toBe('audio');
      expect(getFileViewMode('voice.ogg')).toBe('audio');
    });

    it('video → video mode', () => {
      expect(getFileViewMode('clip.mp4')).toBe('video');
      expect(getFileViewMode('movie.mkv')).toBe('video');
    });

    it('office → office mode', () => {
      expect(getFileViewMode('doc.docx')).toBe('office');
      expect(getFileViewMode('sheet.xlsx')).toBe('office');
      expect(getFileViewMode('slides.pptx')).toBe('office');
    });

    it('code/text → editor mode', () => {
      expect(getFileViewMode('main.ts')).toBe('editor');
      expect(getFileViewMode('README.md')).toBe('editor');
      expect(getFileViewMode('config.json')).toBe('editor');
    });

    it('no extension → editor mode', () => {
      expect(getFileViewMode('Makefile')).toBe('editor');
      expect(getFileViewMode('.gitignore')).toBe('editor');
    });
  });

  describe('getFileTypeLabel', () => {
    it('returns correct labels', () => {
      expect(getFileTypeLabel('photo.png')).toBe('Image');
      expect(getFileTypeLabel('doc.pdf')).toBe('PDF Document');
      expect(getFileTypeLabel('song.mp3')).toBe('Audio');
      expect(getFileTypeLabel('clip.mp4')).toBe('Video');
      expect(getFileTypeLabel('data.xlsx')).toBe('Spreadsheet');
      expect(getFileTypeLabel('slides.pptx')).toBe('Presentation');
      expect(getFileTypeLabel('letter.docx')).toBe('Document');
    });

    it('returns Text File for no extension', () => {
      expect(getFileTypeLabel('Dockerfile')).toBe('File');
      expect(getFileTypeLabel('.env')).toBe('Text File');
    });
  });

  describe('detectFileCategory', () => {
    it('terminal tools → terminal', () => {
      expect(detectFileCategory(undefined, 'bash')).toBe('terminal');
      expect(detectFileCategory(undefined, 'execute')).toBe('terminal');
      expect(detectFileCategory(undefined, 'shell')).toBe('terminal');
    });

    it('markdown → markdown', () => {
      expect(detectFileCategory('README.md', 'read')).toBe('markdown');
      expect(detectFileCategory('guide.mdx', 'read')).toBe('markdown');
    });

    it('images → image', () => {
      expect(detectFileCategory('photo.png', 'read')).toBe('image');
    });

    it('pdf → pdf', () => {
      expect(detectFileCategory('report.pdf', 'read')).toBe('pdf');
    });

    it('office → office', () => {
      expect(detectFileCategory('doc.docx', 'read')).toBe('office');
    });

    it('code → code', () => {
      expect(detectFileCategory('main.ts', 'read')).toBe('code');
      expect(detectFileCategory('app.py', 'read')).toBe('code');
    });

    it('unknown ext → text', () => {
      expect(detectFileCategory('notes.txt', 'read')).toBe('text');
    });

    it('no file path → text', () => {
      expect(detectFileCategory(undefined, 'read')).toBe('text');
    });
  });

  describe('extToLanguage', () => {
    it('maps common languages', () => {
      expect(extToLanguage('file.ts')).toBe('typescript');
      expect(extToLanguage('file.tsx')).toBe('tsx');
      expect(extToLanguage('file.py')).toBe('python');
      expect(extToLanguage('file.rs')).toBe('rust');
      expect(extToLanguage('file.go')).toBe('go');
      expect(extToLanguage('file.java')).toBe('java');
    });

    it('maps shell scripts', () => {
      expect(extToLanguage('script.sh')).toBe('bash');
      expect(extToLanguage('script.zsh')).toBe('bash');
    });

    it('maps web languages', () => {
      expect(extToLanguage('page.html')).toBe('markup');
      expect(extToLanguage('style.css')).toBe('css');
      expect(extToLanguage('data.json')).toBe('json');
    });

    it('returns empty string for unknown', () => {
      expect(extToLanguage('file.xyz')).toBe('');
    });
  });
});

// ─────────────────────────────────────────────────────────────────
// 3. Provider Registry & Configuration
// ─────────────────────────────────────────────────────────────────

describe('Provider Registry', () => {
  describe('BUILTIN_PROVIDER_TYPES', () => {
    it('includes all expected providers', () => {
      expect(BUILTIN_PROVIDER_TYPES).toContain('anthropic');
      expect(BUILTIN_PROVIDER_TYPES).toContain('openai');
      expect(BUILTIN_PROVIDER_TYPES).toContain('google');
      expect(BUILTIN_PROVIDER_TYPES).toContain('openrouter');
      expect(BUILTIN_PROVIDER_TYPES).toContain('ollama');
      expect(BUILTIN_PROVIDER_TYPES.length).toBe(8);
    });
  });

  describe('getProviderEnvVar', () => {
    it('returns env var for known providers', () => {
      expect(getProviderEnvVar('anthropic')).toBe('ANTHROPIC_API_KEY');
      expect(getProviderEnvVar('openai')).toBe('OPENAI_API_KEY');
      expect(getProviderEnvVar('google')).toBe('GEMINI_API_KEY');
    });

    it('returns undefined for providers without env vars', () => {
      expect(getProviderEnvVar('openai-codex')).toBeUndefined();
    });

    it('returns undefined for unknown provider', () => {
      expect(getProviderEnvVar('nonexistent')).toBeUndefined();
    });
  });

  describe('getProviderDefaultModel', () => {
    it('returns default models', () => {
      expect(getProviderDefaultModel('anthropic')).toContain('claude');
      expect(getProviderDefaultModel('openai')).toContain('gpt');
      expect(getProviderDefaultModel('google')).toContain('gemini');
    });

    it('returns undefined for unknown provider', () => {
      expect(getProviderDefaultModel('nonexistent')).toBeUndefined();
    });
  });

  describe('getProviderConfig', () => {
    it('returns config with baseUrl and api for custom-config providers', () => {
      const openai = getProviderConfig('openai');
      expect(openai).toBeDefined();
      expect(openai?.baseUrl).toBe('https://api.openai.com/v1');
      expect(openai?.api).toBe('openai-responses');
      expect(openai?.apiKeyEnv).toBe('OPENAI_API_KEY');
    });

    it('returns undefined for built-in providers (no providerConfig needed)', () => {
      expect(getProviderConfig('anthropic')).toBeUndefined();
      expect(getProviderConfig('google')).toBeUndefined();
    });

    it('includes models for providers with custom model lists', () => {
      const moonshot = getProviderConfig('moonshot');
      expect(moonshot?.models).toBeDefined();
      expect(moonshot?.models?.[0]?.id).toBe('kimi-k2.5');
    });
  });

  describe('getKeyableProviderTypes', () => {
    it('returns all providers that use API keys (env vars)', () => {
      const keyable = getKeyableProviderTypes();
      expect(keyable).toContain('anthropic');
      expect(keyable).toContain('openai');
      expect(keyable).toContain('google');
      // openai-codex is OAuth only, no env var
      expect(keyable).not.toContain('openai-codex');
    });
  });
});

describe('Provider UI Metadata', () => {
  it('has info for all provider types including custom', () => {
    expect(PROVIDER_TYPE_INFO.length).toBe(9); // 8 builtin + custom
  });

  it('getProviderTypeInfo finds by id', () => {
    const anthropic = getProviderTypeInfo('anthropic');
    expect(anthropic?.name).toBe('Anthropic');
    expect(anthropic?.requiresApiKey).toBe(true);
    expect(anthropic?.supportsOAuth).toBe(true);
  });

  it('Google supports OAuth with oauth2 type', () => {
    const google = getProviderTypeInfo('google');
    expect(google?.supportsOAuth).toBe(true);
    expect(google?.oauthType).toBe('oauth2');
  });

  it('Ollama does not require API key', () => {
    const ollama = getProviderTypeInfo('ollama');
    expect(ollama?.requiresApiKey).toBe(false);
    expect(ollama?.showBaseUrl).toBe(true);
    expect(ollama?.showModelId).toBe(true);
  });

  it('shouldInvertInDark returns true for all providers', () => {
    expect(shouldInvertInDark('anthropic')).toBe(true);
    expect(shouldInvertInDark('google')).toBe(true);
  });

  it('frontend types align with backend registry', () => {
    // Every BUILTIN_PROVIDER_TYPE should have a matching PROVIDER_TYPE_INFO entry
    for (const type of BUILTIN_PROVIDER_TYPES) {
      const info = getProviderTypeInfo(type);
      expect(info, `Missing UI info for provider "${type}"`).toBeDefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// 4. Utility Functions
// ─────────────────────────────────────────────────────────────────

describe('Utility Functions', () => {
  describe('formatRelativeTime', () => {
    it('returns "just now" for very recent times', () => {
      expect(formatRelativeTime(new Date())).toBe('just now');
    });

    it('returns minutes ago', () => {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
      expect(formatRelativeTime(fiveMinAgo)).toBe('5 minutes ago');
    });

    it('returns hours ago', () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      expect(formatRelativeTime(twoHoursAgo)).toBe('2 hours ago');
    });

    it('returns days ago', () => {
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      expect(formatRelativeTime(threeDaysAgo)).toBe('3 days ago');
    });
  });

  describe('formatDuration', () => {
    it('formats zero', () => {
      expect(formatDuration(0)).toBe('0s');
    });

    it('formats large durations', () => {
      expect(formatDuration(7200)).toBe('2h 0m');
      expect(formatDuration(90)).toBe('1m 30s');
    });
  });

  describe('truncate', () => {
    it('handles edge cases', () => {
      expect(truncate('', 10)).toBe('');
      expect(truncate('abc', 3)).toBe('abc');
      expect(truncate('abcdef', 5)).toBe('ab...');
    });
  });

  describe('delay', () => {
    it('resolves after specified time', async () => {
      const start = Date.now();
      await delay(50);
      expect(Date.now() - start).toBeGreaterThanOrEqual(40); // allow some tolerance
    });
  });
});

// ─────────────────────────────────────────────────────────────────
// 5. Store Integration — Provider Lifecycle Simulation
// ─────────────────────────────────────────────────────────────────

describe('Provider Store — Lifecycle Simulation', () => {
  const ipc = window.electron.ipcRenderer;

  beforeEach(() => {
    useProviderStore.setState({
      providers: [],
      defaultProviderId: null,
      loading: false,
      error: null,
      oauthStatus: {},
    });
    vi.clearAllMocks();
  });

  it('fetchProviders loads provider list from IPC', async () => {
    const mockProviders = [
      { id: 'p1', name: 'My Anthropic', type: 'anthropic', enabled: true, hasKey: true, keyMasked: 'sk-ant-***' },
    ];
    (ipc.invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockProviders) // provider:list
      .mockResolvedValueOnce('p1'); // provider:getDefault

    await useProviderStore.getState().fetchProviders();

    const state = useProviderStore.getState();
    expect(state.providers).toEqual(mockProviders);
    expect(state.defaultProviderId).toBe('p1');
    expect(state.loading).toBe(false);
  });

  it('fetchProviders handles errors gracefully', async () => {
    (ipc.invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('IPC timeout'));

    await useProviderStore.getState().fetchProviders();

    const state = useProviderStore.getState();
    expect(state.error).toContain('IPC timeout');
    expect(state.loading).toBe(false);
  });

  it('addProvider calls IPC and refreshes list', async () => {
    (ipc.invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ success: true }) // provider:save
      .mockResolvedValueOnce([]) // provider:list (refresh)
      .mockResolvedValueOnce(null); // provider:getDefault (refresh)

    await useProviderStore.getState().addProvider(
      { id: 'p2', name: 'OpenAI', type: 'openai', enabled: true },
      'sk-test-key',
    );

    expect(ipc.invoke).toHaveBeenCalledWith(
      'provider:save',
      expect.objectContaining({ id: 'p2', name: 'OpenAI', type: 'openai' }),
      'sk-test-key',
    );
  });

  it('addProvider throws on IPC failure', async () => {
    (ipc.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      error: 'Duplicate provider',
    });

    await expect(
      useProviderStore.getState().addProvider(
        { id: 'p2', name: 'Dupe', type: 'openai', enabled: true },
      ),
    ).rejects.toThrow('Duplicate provider');
  });

  it('validates API key via IPC', async () => {
    (ipc.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      valid: true,
    });

    const result = await useProviderStore.getState().validateApiKey('p1', 'sk-test');
    expect(result.valid).toBe(true);
    expect(ipc.invoke).toHaveBeenCalledWith('provider:validateKey', 'p1', 'sk-test', undefined);
  });

  it('checkOAuthStatus updates oauthStatus state', async () => {
    // checkOAuthStatus calls provider:list and checks if provider has no API key (= OAuth token)
    (ipc.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { type: 'google', hasKey: false }, // no API key means OAuth token is being used
    ]);

    await useProviderStore.getState().checkOAuthStatus('google');

    const state = useProviderStore.getState();
    expect(state.oauthStatus.google).toEqual({
      authenticated: true,
      checking: false,
    });
  });

  it('triggerOAuthLogin returns result from IPC', async () => {
    (ipc.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
    });

    const result = await useProviderStore.getState().triggerOAuthLogin('google');
    expect(result.success).toBe(true);
    expect(ipc.invoke).toHaveBeenCalledWith('provider:oauthLogin', 'google');
  });
});

// ─────────────────────────────────────────────────────────────────
// 6. File Browser Store — Workspace Workflow Simulation
// ─────────────────────────────────────────────────────────────────

describe('File Browser Store — Workspace Simulation', () => {
  const ipc = window.electron.ipcRenderer;

  beforeEach(() => {
    useFileBrowserStore.setState({
      panelOpen: false,
      panelWidth: 0,
      treeWidth: 240,
      rootPath: null,
      entries: {},
      expandedDirs: new Set(),
      selectedFile: null,
      selectedPaths: new Set(),
      lastClickedPath: null,
      fileContent: null,
      fileViewMode: null,
      fileUrl: null,
      fileSize: null,
      fileOfficeData: null,
      fileDirty: false,
      loading: false,
      fileLoading: false,
    });
    vi.clearAllMocks();
  });

  it('togglePanel opens panel and auto-loads if rootPath exists', async () => {
    const mockEntries = [
      { name: 'src', path: '/project/src', isDirectory: true },
      { name: 'README.md', path: '/project/README.md', isDirectory: false },
    ];
    // Pre-set rootPath so togglePanel triggers loadDirectory
    useFileBrowserStore.setState({ rootPath: '/project' });
    (ipc.invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ success: true, files: mockEntries }); // file:listDir

    useFileBrowserStore.getState().togglePanel();

    // Panel should be open immediately
    expect(useFileBrowserStore.getState().panelOpen).toBe(true);

    // Wait for async directory loading
    await vi.waitFor(() => {
      expect(useFileBrowserStore.getState().entries['/project']).toEqual(mockEntries);
    });
  });

  it('selectFile loads text file content via file:readAny', async () => {
    (ipc.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      content: 'console.log("hello")',
    });

    await useFileBrowserStore.getState().selectFile('/project/main.ts');

    const state = useFileBrowserStore.getState();
    expect(state.selectedFile).toBe('/project/main.ts');
    expect(state.fileViewMode).toBe('editor');
    expect(state.fileContent).toBe('console.log("hello")');
  });

  it('selectFile loads image file URL via file:getLocalUrl', async () => {
    (ipc.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      url: 'local-file:///project/photo.png',
      size: 50000,
    });

    await useFileBrowserStore.getState().selectFile('/project/photo.png');

    const state = useFileBrowserStore.getState();
    expect(state.selectedFile).toBe('/project/photo.png');
    expect(state.fileViewMode).toBe('image');
    expect(state.fileUrl).toBe('local-file:///project/photo.png');
  });

  it('updateContent marks file as dirty', () => {
    useFileBrowserStore.setState({
      selectedFile: '/project/main.ts',
      fileContent: 'old content',
      fileViewMode: 'editor',
    });

    useFileBrowserStore.getState().updateContent('new content');

    const state = useFileBrowserStore.getState();
    expect(state.fileContent).toBe('new content');
    expect(state.fileDirty).toBe(true);
  });

  it('saveFile writes content and clears dirty flag', async () => {
    useFileBrowserStore.setState({
      selectedFile: '/project/main.ts',
      fileContent: 'updated code',
      fileDirty: true,
    });
    (ipc.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: true });

    await useFileBrowserStore.getState().saveFile();

    expect(ipc.invoke).toHaveBeenCalledWith('file:writeAny', '/project/main.ts', 'updated code');
    expect(useFileBrowserStore.getState().fileDirty).toBe(false);
  });

  it('closeFile clears file state', () => {
    useFileBrowserStore.setState({
      selectedFile: '/project/main.ts',
      fileContent: 'content',
      fileViewMode: 'editor',
      fileDirty: true,
    });

    useFileBrowserStore.getState().closeFile();

    const state = useFileBrowserStore.getState();
    expect(state.selectedFile).toBeNull();
    expect(state.fileContent).toBeNull();
    expect(state.fileViewMode).toBeNull();
    expect(state.fileDirty).toBe(false);
  });

  it('panel width and tree width are adjustable', () => {
    useFileBrowserStore.getState().setPanelWidth(600);
    expect(useFileBrowserStore.getState().panelWidth).toBe(600);

    useFileBrowserStore.getState().setTreeWidth(300);
    expect(useFileBrowserStore.getState().treeWidth).toBe(300);
  });

  it('multi-select with setSelectedPaths', () => {
    const paths = new Set(['/project/a.ts', '/project/b.ts']);
    useFileBrowserStore.getState().setSelectedPaths(paths);
    expect(useFileBrowserStore.getState().selectedPaths).toEqual(paths);

    useFileBrowserStore.getState().clearSelection();
    expect(useFileBrowserStore.getState().selectedPaths.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// 7. Channels Store — Channel Management Simulation
// ─────────────────────────────────────────────────────────────────

describe('Channels Store — Channel Management', () => {
  const ipc = window.electron.ipcRenderer;

  beforeEach(() => {
    useChannelsStore.setState({
      channels: [],
      bindings: [],
      loading: false,
      error: null,
    });
    vi.clearAllMocks();
  });

  it('fetchChannels parses gateway RPC response', async () => {
    (ipc.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      result: {
        channelOrder: ['telegram'],
        channels: { telegram: { configured: true } },
        channelAccounts: {
          telegram: [{
            accountId: 'bot1',
            configured: true,
            connected: true,
            running: true,
            enabled: true,
            name: 'MyBot',
            lastStartAt: Date.now(),
          }],
        },
        channelDefaultAccountId: { telegram: 'bot1' },
      },
    });

    await useChannelsStore.getState().fetchChannels();

    const state = useChannelsStore.getState();
    expect(state.channels.length).toBeGreaterThanOrEqual(1);
    expect(state.channels[0].type).toBe('telegram');
    expect(state.loading).toBe(false);
  });

  it('fetchChannels handles RPC error gracefully (shows empty list)', async () => {
    (ipc.invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Gateway not connected'),
    );

    await useChannelsStore.getState().fetchChannels();

    const state = useChannelsStore.getState();
    // fetchChannels silently catches errors and shows empty channels
    expect(state.channels).toEqual([]);
    expect(state.loading).toBe(false);
  });

  it('setChannels updates state directly', () => {
    useChannelsStore.getState().setChannels([
      { id: 'ch1', type: 'discord', name: 'My Discord', status: 'connected' } as any,
    ]);
    expect(useChannelsStore.getState().channels.length).toBe(1);
  });

  it('clearError resets error state', () => {
    useChannelsStore.setState({ error: 'some error' });
    useChannelsStore.getState().clearError();
    expect(useChannelsStore.getState().error).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// 8. Settings + Gateway Store — App Initialization Simulation
// ─────────────────────────────────────────────────────────────────

describe('App Initialization Simulation', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      theme: 'system',
      language: 'en',
      sidebarCollapsed: false,
      devModeUnlocked: false,
      gatewayAutoStart: true,
      gatewayPort: 18789,
      autoCheckUpdate: true,
      autoDownloadUpdate: false,
      startMinimized: true,
      launchAtStartup: true,
      updateChannel: 'stable',
    });
    useGatewayStore.setState({
      status: { state: 'stopped', port: 18789 },
      isInitialized: false,
    });
    vi.clearAllMocks();
  });

  it('simulates full app boot sequence', () => {
    // 1. Settings loaded with defaults
    const settings = useSettingsStore.getState();
    expect(settings.gatewayAutoStart).toBe(true);
    expect(settings.gatewayPort).toBe(18789);
    expect(settings.theme).toBe('system');

    // 2. Gateway starts
    const { setStatus } = useGatewayStore.getState();
    setStatus({ state: 'starting', port: 18789 });
    expect(useGatewayStore.getState().status.state).toBe('starting');

    // 3. Gateway connects
    setStatus({ state: 'running', port: 18789, pid: 12345 });
    expect(useGatewayStore.getState().status.state).toBe('running');
    expect(useGatewayStore.getState().status.pid).toBe(12345);
  });

  it('simulates theme switching', () => {
    const { setTheme } = useSettingsStore.getState();

    setTheme('dark');
    expect(useSettingsStore.getState().theme).toBe('dark');

    setTheme('light');
    expect(useSettingsStore.getState().theme).toBe('light');

    setTheme('system');
    expect(useSettingsStore.getState().theme).toBe('system');
  });

  it('simulates language change', () => {
    useSettingsStore.getState().setLanguage('vi');
    expect(useSettingsStore.getState().language).toBe('vi');

    useSettingsStore.getState().setLanguage('ja');
    expect(useSettingsStore.getState().language).toBe('ja');
  });

  it('simulates gateway port change', () => {
    useSettingsStore.getState().setGatewayPort(19000);
    expect(useSettingsStore.getState().gatewayPort).toBe(19000);
  });

  it('simulates gateway error → recovery cycle', () => {
    const { setStatus } = useGatewayStore.getState();

    // Running
    setStatus({ state: 'running', port: 18789, pid: 100 });
    expect(useGatewayStore.getState().status.state).toBe('running');

    // Error occurs
    setStatus({ state: 'error', port: 18789, error: 'Connection refused' });
    expect(useGatewayStore.getState().status.state).toBe('error');
    expect(useGatewayStore.getState().status.error).toBe('Connection refused');

    // Restart → recovery
    setStatus({ state: 'starting', port: 18789 });
    setStatus({ state: 'running', port: 18789, pid: 101 });
    expect(useGatewayStore.getState().status.state).toBe('running');
    expect(useGatewayStore.getState().status.pid).toBe(101);
  });
});

// ─────────────────────────────────────────────────────────────────
// 9. Cross-System Integration — Full User Workflow
// ─────────────────────────────────────────────────────────────────

describe('Cross-System Integration — Full User Workflow', () => {
  const ipc = window.electron.ipcRenderer;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('simulates: boot → add provider → open workspace → edit file → save', async () => {
    // Step 1: App boots, gateway starts
    useGatewayStore.getState().setStatus({ state: 'running', port: 18789, pid: 999 });
    expect(useGatewayStore.getState().status.state).toBe('running');

    // Step 2: User adds a provider
    useProviderStore.setState({ providers: [], defaultProviderId: null, loading: false, error: null, oauthStatus: {} });
    (ipc.invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ success: true }) // provider:save
      .mockResolvedValueOnce([ // provider:list (refresh)
        { id: 'p1', name: 'Anthropic', type: 'anthropic', enabled: true, hasKey: true, keyMasked: 'sk-***' },
      ])
      .mockResolvedValueOnce('p1'); // provider:getDefault (refresh)

    await useProviderStore.getState().addProvider(
      { id: 'p1', name: 'Anthropic', type: 'anthropic', enabled: true },
      'sk-ant-test',
    );
    // After addProvider, fetchProviders is called which updates the list
    await vi.waitFor(() => {
      expect(useProviderStore.getState().providers.length).toBe(1);
    });

    // Step 3: User opens workspace panel (with rootPath pre-set)
    useFileBrowserStore.setState({
      panelOpen: false, rootPath: '/project', entries: {}, expandedDirs: new Set(),
      selectedFile: null, fileContent: null, fileViewMode: null, fileDirty: false,
      panelWidth: 0, treeWidth: 240, selectedPaths: new Set(), lastClickedPath: null,
      fileUrl: null, fileSize: null, fileOfficeData: null, loading: false, fileLoading: false,
    });
    (ipc.invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ success: true, files: [ // file:listDir
        { name: 'main.ts', path: '/project/main.ts', isDirectory: false },
      ]});

    useFileBrowserStore.getState().togglePanel();
    expect(useFileBrowserStore.getState().panelOpen).toBe(true);

    // Step 4: User selects a file
    (ipc.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      content: 'const x = 1;',
    });

    await useFileBrowserStore.getState().selectFile('/project/main.ts');
    expect(useFileBrowserStore.getState().fileViewMode).toBe('editor');
    expect(useFileBrowserStore.getState().fileContent).toBe('const x = 1;');

    // Step 5: User edits and saves
    useFileBrowserStore.getState().updateContent('const x = 42;');
    expect(useFileBrowserStore.getState().fileDirty).toBe(true);

    (ipc.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: true });
    await useFileBrowserStore.getState().saveFile();
    expect(useFileBrowserStore.getState().fileDirty).toBe(false);
  });
});
