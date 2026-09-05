import type { CharacterClass, Gender } from './characterClass.ts'

/** Class + gender → figure index: 8 classes x 2 genders → 16 slots. */
export function figureIndex(characterClass: CharacterClass, gender: Gender): number {
  return characterClass * 2 + gender
}
