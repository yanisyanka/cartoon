/**
 * HTTP-клиент ComfyUI.
 *
 * Только транспорт: знает ручки и формы ответов, не знает ни про ассеты, ни про
 * происхождение. Зависимостей нет — в Node 24 есть и fetch, и FormData.
 *
 * Все вызовы локальные, на 127.0.0.1. Ни одной внешней сети, ни одного платного
 * сервиса: это структурное свойство, а не обещание — базовый адрес приходит из
 * конфигурации и проверяется на локальность до первого запроса.
 */
import { ProviderResponseError } from '@core/index';

export type ComfyUploadResult = { name: string; subfolder: string; type: string };

export type ComfyImageRef = { filename: string; subfolder: string; type: string };

export type ComfySystemStats = {
  system?: {
    os?: string;
    comfyui_version?: string;
    python_version?: string;
    pytorch_version?: string;
    ram_total?: number;
  };
  devices?: { name?: string; type?: string; vram_total?: number }[];
};

/** Что видно в истории про конкретный запуск. */
export type ComfyHistoryEntry = {
  status?: { completed?: boolean; status_str?: string; messages?: unknown[] };
  outputs?: Record<string, { images?: ComfyImageRef[] }>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export class ComfyClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 60_000
  ) {}

  /** Локален ли адрес. Проверяется до запроса, а не после. */
  static isLocal(baseUrl: string): boolean {
    try {
      const { hostname } = new URL(baseUrl);
      return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
    } catch {
      return false;
    }
  }

  get origin(): string {
    return this.baseUrl;
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ProviderResponseError(
        `ComfyUI ответил ${response.status} на ${path}: ${body.slice(0, 400)}`
      );
    }
    return response;
  }

  async systemStats(): Promise<ComfySystemStats> {
    const response = await this.request('/system_stats');
    return (await response.json()) as ComfySystemStats;
  }

  /** Имена узлов, известные серверу. По ним проверяется применимость workflow. */
  async knownNodeTypes(): Promise<Set<string>> {
    const response = await this.request('/object_info');
    const payload = asRecord(await response.json());
    return new Set(payload ? Object.keys(payload) : []);
  }

  /**
   * Загрузить изображение во входной каталог ComfyUI.
   *
   * Это копия: исходный файл не читается на запись и не перемещается. Копия
   * живёт в каталоге ComfyUI, за пределами корня медиа, поэтому в реестр она не
   * попадает и дерево проекта не засоряет.
   *
   * overwrite=false намеренно: ComfyUI сам придумает свободное имя, если такое
   * уже есть, и вернёт его. Затирать чужой вход мы не вправе даже у себя.
   */
  async uploadImage(fileName: string, bytes: Buffer): Promise<ComfyUploadResult> {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(bytes)]), fileName);
    form.append('overwrite', 'false');

    const response = await this.request('/upload/image', { method: 'POST', body: form });
    const payload = asRecord(await response.json());

    const name = payload?.['name'];
    if (typeof name !== 'string' || name.length === 0) {
      throw new ProviderResponseError(
        `ComfyUI не сообщил имя загруженного файла: ${JSON.stringify(payload).slice(0, 300)}`
      );
    }

    return {
      name,
      subfolder: typeof payload?.['subfolder'] === 'string' ? payload['subfolder'] : '',
      type: typeof payload?.['type'] === 'string' ? payload['type'] : 'input'
    };
  }

  /** Поставить граф в очередь. Возвращает дескриптор запуска. */
  async queuePrompt(graph: unknown, clientId: string): Promise<string> {
    const response = await this.request('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: graph, client_id: clientId })
    });

    const payload = asRecord(await response.json());
    const promptId = payload?.['prompt_id'];

    if (typeof promptId !== 'string' || promptId.length === 0) {
      const errors = payload?.['node_errors'];
      throw new ProviderResponseError(
        'ComfyUI не принял граф. ' +
          (errors ? `Ошибки узлов: ${JSON.stringify(errors).slice(0, 600)}` : '')
      );
    }

    return promptId;
  }

  /** Запись истории. null — запуск ещё не завершён. */
  async history(promptId: string): Promise<ComfyHistoryEntry | null> {
    const response = await this.request(`/history/${promptId}`);
    const payload = asRecord(await response.json());
    const entry = payload?.[promptId];
    return entry ? (entry as ComfyHistoryEntry) : null;
  }

  /** Сколько задач в очереди — это и есть queueDepth для учёта нагрузки. */
  async queueDepth(): Promise<number | null> {
    try {
      const response = await this.request('/queue');
      const payload = asRecord(await response.json());
      const running = Array.isArray(payload?.['queue_running'])
        ? (payload['queue_running'] as unknown[]).length
        : 0;
      const pending = Array.isArray(payload?.['queue_pending'])
        ? (payload['queue_pending'] as unknown[]).length
        : 0;
      return running + pending;
    } catch {
      // Глубина очереди — диагностика, а не часть результата.
      return null;
    }
  }

  /** Забрать готовый файл. */
  async view(ref: ComfyImageRef): Promise<Buffer> {
    const query = new URLSearchParams({
      filename: ref.filename,
      subfolder: ref.subfolder,
      type: ref.type
    });
    const response = await this.request(`/view?${query.toString()}`);
    return Buffer.from(await response.arrayBuffer());
  }
}
