import { SOMNIO_CONSTANTS } from '@/core/constants'
import { element, field, numberField, select, setSelectValue } from '@/ui/dom'
import { validSectorDimensions } from '../preferences'
import { isValidSectorName } from '../sectorName'

/**
 * The sector form, shared by New Map and Sector Settings: name,
 * tile dimensions (bounded to the codec's per-axis cap), Indoor, brightness, and the
 * floor-material picker, plus the inline validation line gating OK/Apply. Indoor and
 * brightness **are** the sector `light` setting — there is no additional light control.
 */

export interface SectorFormValues {
  name: string
  width: number
  height: number
  indoor: boolean
  brightness: number
  floorMaterialID: string
}

export function validationMessage(values: SectorFormValues): string | undefined {
  if (values.name === '') return 'Fill in sector name!'
  // The same predicate the file middleware enforces, so a name the form accepts is exactly
  // a name the API serves.
  if (!isValidSectorName(values.name)) return 'Invalid sector name!'
  if (
    !Number.isInteger(values.width) ||
    !Number.isInteger(values.height) ||
    !validSectorDimensions(values.width, values.height)
  ) {
    return 'Invalid sector size!'
  }
  return undefined
}

export class SectorForm {
  readonly root: HTMLElement

  private readonly nameInput: HTMLInputElement
  private readonly widthInput: HTMLInputElement
  private readonly heightInput: HTMLInputElement
  private readonly indoorInput: HTMLSelectElement
  private readonly brightnessInput: HTMLInputElement
  private readonly floorMaterialInput: HTMLSelectElement
  private readonly validationLine: HTMLElement

  constructor(floorMaterialIDs: readonly string[], onChanged: () => void) {
    const name = field('Sector name')
    const width = numberField('Width', { min: 1, max: SOMNIO_CONSTANTS.maxSectorDimension, value: 20 })
    const height = numberField('Height', { min: 1, max: SOMNIO_CONSTANTS.maxSectorDimension, value: 15 })
    const indoor = select('Indoor', [
      { value: 'false', label: 'No' },
      { value: 'true', label: 'Yes' },
    ])
    const brightness = numberField('Light', { min: 0, max: 100, value: 100 })
    const floorMaterial = select(
      'Floor material',
      floorMaterialIDs.map((id) => ({ value: id, label: id }))
    )
    this.nameInput = name.input
    this.widthInput = width.input
    this.heightInput = height.input
    this.indoorInput = indoor.input
    this.brightnessInput = brightness.input
    this.floorMaterialInput = floorMaterial.input
    this.validationLine = element('p', { className: 'form-error hidden' })
    this.root = element('div', {
      children: [
        name.row,
        width.row,
        height.row,
        indoor.row,
        brightness.row,
        floorMaterial.row,
        this.validationLine,
      ],
    })
    for (const input of [this.nameInput, this.widthInput, this.heightInput, this.brightnessInput]) {
      input.addEventListener('input', onChanged)
    }
    this.indoorInput.addEventListener('change', onChanged)
    this.floorMaterialInput.addEventListener('change', onChanged)
  }

  setValues(values: SectorFormValues): void {
    this.nameInput.value = values.name
    this.widthInput.value = String(values.width)
    this.heightInput.value = String(values.height)
    this.indoorInput.value = String(values.indoor)
    this.brightnessInput.value = String(values.brightness)
    setSelectValue(this.floorMaterialInput, values.floorMaterialID)
  }

  values(): SectorFormValues {
    return {
      name: this.nameInput.value,
      width: Number(this.widthInput.value),
      height: Number(this.heightInput.value),
      indoor: this.indoorInput.value === 'true',
      brightness: clampBrightness(Number(this.brightnessInput.value)),
      floorMaterialID: this.floorMaterialInput.value,
    }
  }

  /** Refreshes the validation line; returns whether the values are committable. */
  renderValidation(): boolean {
    const message = validationMessage(this.values())
    this.validationLine.textContent = message ?? ''
    this.validationLine.classList.toggle('hidden', message === undefined)
    return message === undefined
  }

  focusName(): void {
    this.nameInput.focus()
  }
}

/** The `Stepper(in: 0...100)` bound; a hand-typed out-of-range value clamps like the stepper. */
function clampBrightness(value: number): number {
  if (!Number.isInteger(value)) return 100
  return Math.min(Math.max(value, 0), 100)
}
