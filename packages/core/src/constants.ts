/** The game's fixed numbers. Lengths are metres. */
export const SOMNIO_CONSTANTS = {
  playerRadius: 0.3,
  npcRadius: 0.3,
  /** How much narrower than the body the path between two reported positions is sampled. */
  pathTolerance: 0.01,
  /** The largest rise or drop between two walk surfaces a body takes in one step. */
  maxStepHeight: 0.3,
  /** How far a door's trigger reaches out from its anchor: deeper than a body's radius, shallower than the arrival offset. */
  doorTriggerDepth: 0.58,
  /** Speaking distance: how far from an NPC a dreamer can talk to it, and keep a master's offer open. */
  npcInteractionRadius: 2,
  /** How far outside a door's trigger the server still accepts a `useDoor`. */
  doorUseSlack: 1.0,

  maxSectorNPCs: 4096,
  maxSectorMonsterSpawns: 4096,
  /** Cap on one monster spawn's `maxAlive`. */
  maxSpawnAlive: 16,
  /** Wall-clock gap between two lines an NPC says when asked, and between two greetings. The first line asked for after a greeting is not held back. */
  npcDialogCooldownSeconds: 3.0,
  /** How long after greeting a dreamer an NPC does not greet them again, however often they come back while they stay in its space. */
  npcGreetingPauseSeconds: 30,
  /** An outdoor sector narrower than this would let the camera see past its neighbour. */
  minOutdoorSectorExtent: 16,

  speechBubbleWidthPixels: 150,
  speechBubbleFontSize: 10,

  /**
   * Byte cap on a `.somnio-sector` file, checked before parsing — the count caps only fire
   * after the whole input is parsed.
   */
  maxSectorFileBytes: 16 * 1024 * 1024,
} as const;
