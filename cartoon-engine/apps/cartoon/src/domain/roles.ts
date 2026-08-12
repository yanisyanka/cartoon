/**
 * Словарь ролей ассета.
 *
 * Живёт в приложении, а не в ядре, и это осознанно. `ref-front` и `turnaround`
 * — слова из производства мультфильма; движок, который завтра будет собирать
 * что-то другое, о них знать не обязан. Ядро хранит роль как непрозрачную
 * строку, а словарь и его проверка принадлежат тому слою, который знает
 * предметную область.
 */
import { InvariantError } from '@core/index';

export const ASSET_ROLES = [
  /** Фронтальный эталон персонажа — то, с чего начинается всё остальное. */
  'ref-front',
  /**
   * Тёмная карточка с именем и должностью, 190×325. Роль подтверждается
   * размером кадра, а не именем файла.
   */
  'card',
  /** Готовый вертикальный клип персонажа, 828×1108, около 5 секунд. */
  'clip',
  /** Лист ракурсов: ¾ слева, ¾ справа, затылок. */
  'turnaround',
  /** Стилл под смену эмоции: закрытые глаза, прищур, удивление, вина. */
  'emotion-still',
  /** Фон или задник плана. */
  'plate',
  /** Раскадровка. */
  'storyboard',
  /** Готовый рендер плана или эпизода. */
  'render',
  /** Классифицировано, но ни в одну из категорий выше не попадает. */
  'other'
] as const;

export type AssetRole = (typeof ASSET_ROLES)[number];

export function isAssetRole(value: string): value is AssetRole {
  return (ASSET_ROLES as readonly string[]).includes(value);
}

export function assertAssetRole(value: string): asserts value is AssetRole {
  if (!isAssetRole(value)) {
    throw new InvariantError(
      `Неизвестная роль ассета: ${value}. Допустимые: ${ASSET_ROLES.join(', ')}.`
    );
  }
}
