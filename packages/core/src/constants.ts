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
  /** How far from a carrier, an NPC or a fixture's placement centre, a dreamer can act on it and keep its panel open. */
  speakingDistance: 2,
  /** How far outside a door's trigger the server still accepts a `useDoor`. */
  doorUseSlack: 1.0,

  maxSectorNPCs: 4096,
  maxSectorMonsterSpawns: 4096,
  /** Cap on one monster spawn's `maxAlive`. */
  maxSpawnAlive: 16,
  /** The graphemes an NPC line, greeting or step, is written to, in every language, so its bubble keeps to about four lines. */
  npcDialogLineGraphemes: 100,
  /** What each `$name` in an NPC line counts toward `npcDialogLineGraphemes`. */
  npcDialogNameGraphemes: 12,
  /** Cap on the steps one NPC says when asked. */
  maxNPCDialogSteps: 32,
  /** How soon after its last line an NPC says the next step to the dreamer it spoke to, when they ask before that line has been read. */
  npcDialogSkipFloorSeconds: 1,
  /** How long after greeting a dreamer an NPC does not greet them again, however often they come back while they stay in its space. */
  npcGreetingPauseSeconds: 30,
  /** An outdoor sector narrower than this would let the camera see past its neighbour. */
  minOutdoorSectorExtent: 16,

  speechBubbleWidthPixels: 150,
  speechBubbleFontSize: 10,
  /** A line's reading time, which its bubble lasts and an NPC waits out: the base plus a second per `speechReadGraphemesPerSecond` graphemes, at least the minimum. */
  speechReadBaseSeconds: 1,
  speechReadGraphemesPerSecond: 15,
  speechReadMinSeconds: 3,

  /**
   * Byte cap on a `.somnio-sector` file, checked before parsing — the count caps only fire
   * after the whole input is parsed.
   */
  maxSectorFileBytes: 16 * 1024 * 1024,
} as const;
