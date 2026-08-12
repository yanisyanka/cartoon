/**
 * Сборка провайдеров из окружения.
 *
 * Единственное место, где выбирается конкретная реализация. Значений по
 * умолчанию у путей нет: неверный корень ComfyUI не сломает запуск громко — он
 * тихо не найдёт веса, и разбираться в этом придётся гораздо позже.
 */
import { NotConfiguredError, type ImageEditProvider } from '@core/index';
import { ComfyUiImageEditProvider } from '@providers/comfyui';

/**
 * Файлы весов, без которых граф `04_multiview_qwen.json` не запустится.
 *
 * Имена взяты из самого графа, а не придуманы: узел 1 грузит UNET, узлы 15 и 2 —
 * LoRA, узлы 5 и 6 — текстовый энкодер и VAE.
 */
export const COMFYUI_REQUIRED_MODELS = [
  'models/diffusion_models/qwen_image_edit_2509_fp8_e4m3fn.safetensors',
  'models/loras/Qwen-Edit-2509-Multiple-angles.safetensors',
  'models/loras/Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors',
  'models/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors',
  'models/vae/qwen_image_vae.safetensors'
] as const;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new NotConfiguredError(
      `${name} не задан. Добавьте строку ${name}=… в .env — образец в .env.example.`
    );
  }
  return value;
}

export function createImageEditProvider(
  env: NodeJS.ProcessEnv = process.env
): ImageEditProvider {
  return new ComfyUiImageEditProvider({
    baseUrl: required(env, 'COMFYUI_BASE_URL'),
    installRoot: required(env, 'COMFYUI_INSTALL_ROOT'),
    workflowPath: required(env, 'COMFYUI_WORKFLOW'),
    requiredModelFiles: COMFYUI_REQUIRED_MODELS
  });
}
