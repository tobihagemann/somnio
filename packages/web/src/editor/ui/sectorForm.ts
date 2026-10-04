import { SOMNIO_CONSTANTS } from '@somnio/core';
import { SECTOR_KINDS, SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import { element, field, select, setHidden } from '@/ui/dom';
import type { SectorSettings } from '../document';
import { isValidSectorName } from '../sectorName';
import { numberField, setSelectValue } from './editorDom';

/**
 * The sector form, shared by New Map and Sector Settings: name, kind, size in metres, the
 * origin of an outdoor sector, the brightness of an interior, and the floor-material picker,
 * plus the inline validation line gating OK/Apply.
 */

const KIND_LABELS: Record<SectorSettings['kind'], string> = { outdoor: 'Outdoor', interior: 'Interior' };

export function validationMessage(values: SectorSettings): string | undefined {
  if (values.name === '') return 'Fill in sector name!';
  // The same predicate the file middleware enforces, so a name the form accepts is exactly
  // a name the API serves.
  if (!isValidSectorName(values.name)) return 'Invalid sector name!';
  const extents = [values.width, values.depth];
  if (!extents.every((extent) => extent > 0 && extent <= SOMNIO_PROTOCOL_CONSTANTS.maxSectorExtentMetres)) return 'Invalid sector size!';
  if (values.kind === 'interior') return undefined;
  if (Math.min(...extents) < SOMNIO_CONSTANTS.minOutdoorSectorExtent) {
    return `An outdoor sector is at least ${SOMNIO_CONSTANTS.minOutdoorSectorExtent} m wide and deep!`;
  }
  if (![values.originX, values.originZ].every((coordinate) => Math.abs(coordinate) <= SOMNIO_PROTOCOL_CONSTANTS.maxCoordinateMetres)) {
    return 'Invalid sector origin!';
  }
  return undefined;
}

export class SectorForm {
  readonly root: HTMLElement;

  private readonly nameInput: HTMLInputElement;
  private readonly kindInput: HTMLSelectElement;
  private readonly widthInput: HTMLInputElement;
  private readonly depthInput: HTMLInputElement;
  private readonly originXInput: HTMLInputElement;
  private readonly originZInput: HTMLInputElement;
  private readonly brightnessInput: HTMLInputElement;
  private readonly floorMaterialInput: HTMLSelectElement;
  private readonly outdoorRows: HTMLElement[];
  private readonly interiorRows: HTMLElement[];
  private readonly validationLine: HTMLElement;

  constructor(floorMaterialIds: readonly string[], onChanged: () => void) {
    const extent = { min: 0, max: SOMNIO_PROTOCOL_CONSTANTS.maxSectorExtentMetres, step: 0.01 };
    const coordinate = { min: -SOMNIO_PROTOCOL_CONSTANTS.maxCoordinateMetres, max: SOMNIO_PROTOCOL_CONSTANTS.maxCoordinateMetres, step: 0.01, value: 0 };
    const name = field('Sector name');
    const kind = select(
      'Kind',
      SECTOR_KINDS.map((value) => ({ value, label: KIND_LABELS[value] })),
    );
    const width = numberField('Width (m)', { ...extent, value: 32 });
    const depth = numberField('Depth (m)', { ...extent, value: 32 });
    const originX = numberField('Origin X (m)', coordinate);
    const originZ = numberField('Origin Z (m)', coordinate);
    const brightness = numberField('Light', { min: 0, max: 100, step: 1, value: 100 });
    const floorMaterial = select(
      'Floor material',
      floorMaterialIds.map((id) => ({ value: id, label: id })),
    );
    this.nameInput = name.input;
    this.kindInput = kind.input;
    this.widthInput = width.input;
    this.depthInput = depth.input;
    this.originXInput = originX.input;
    this.originZInput = originZ.input;
    this.brightnessInput = brightness.input;
    this.floorMaterialInput = floorMaterial.input;
    this.outdoorRows = [originX.row, originZ.row];
    this.interiorRows = [brightness.row];
    this.validationLine = element('p', { className: 'form-error hidden' });
    this.root = element('div', {
      children: [name.row, kind.row, width.row, depth.row, originX.row, originZ.row, brightness.row, floorMaterial.row, this.validationLine],
    });
    for (const input of [this.nameInput, this.widthInput, this.depthInput, this.originXInput, this.originZInput, this.brightnessInput]) {
      input.addEventListener('input', onChanged);
    }
    this.kindInput.addEventListener('change', () => {
      this.showKindRows();
      onChanged();
    });
    this.floorMaterialInput.addEventListener('change', onChanged);
    this.showKindRows();
  }

  setValues(values: SectorSettings): void {
    this.nameInput.value = values.name;
    this.kindInput.value = values.kind;
    this.widthInput.value = String(values.width);
    this.depthInput.value = String(values.depth);
    this.originXInput.value = String(values.originX);
    this.originZInput.value = String(values.originZ);
    this.brightnessInput.value = String(values.brightness);
    setSelectValue(this.floorMaterialInput, values.floorMaterialId);
    this.showKindRows();
  }

  values(): SectorSettings {
    return {
      name: this.nameInput.value,
      kind: this.kindInput.value === 'interior' ? 'interior' : 'outdoor',
      width: Number(this.widthInput.value),
      depth: Number(this.depthInput.value),
      originX: Number(this.originXInput.value),
      originZ: Number(this.originZInput.value),
      brightness: clampBrightness(Number(this.brightnessInput.value)),
      floorMaterialId: this.floorMaterialInput.value,
    };
  }

  /** Refreshes the validation line; returns whether the values are committable. */
  renderValidation(): boolean {
    const message = validationMessage(this.values());
    this.validationLine.textContent = message ?? '';
    this.validationLine.classList.toggle('hidden', message === undefined);
    return message === undefined;
  }

  focusName(): void {
    this.nameInput.focus();
  }

  /** An outdoor sector has an origin and no brightness of its own; an interior the reverse. */
  private showKindRows(): void {
    const interior = this.kindInput.value === 'interior';
    for (const row of this.outdoorRows) setHidden(row, interior);
    for (const row of this.interiorRows) setHidden(row, !interior);
  }
}

/** Brightness is a whole percentage; a hand-typed out-of-range value clamps like the stepper. */
function clampBrightness(value: number): number {
  if (!Number.isInteger(value)) return 100;
  return Math.min(Math.max(value, 0), 100);
}
