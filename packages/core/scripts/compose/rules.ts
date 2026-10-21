import type { Point } from '../../src/geometry.ts';

/**
 * How each outdoor land is composed: its roads, the open ground it keeps, what it keeps clear
 * for the splash reel, and the models its clusters and loose props are drawn from. Every point is
 * in the outdoor space's coordinates, so a road is one line across the lands it crosses.
 */

export interface Road {
  id: string;
  materialId: string;
  /** Half the road's width. */
  radius: number;
  opacity: number;
  points: Point[];
}

export interface Circle extends Point {
  radius: number;
}

/** A line a figure walks, kept clear of anything that blocks for `radius` either side. */
export interface KeepOut {
  points: Point[];
  radius: number;
}

export interface LandRules {
  sector: string;
  seed: number;
  /** Ground that stays open: no cluster and no loose prop. */
  clearings: Circle[];
  /** Worn patches of dirt on the ground. */
  worn: Circle[];
  /** Clusters per dressed 8 x 8 m window, and how many trees each holds. */
  clustersPerWindow: number;
  clusterTrees: [min: number, max: number];
  clusterRadius: number;
  /** Loose bushes and rocks per dressed 8 x 8 m window. */
  propsPerWindow: number;
  trees: string[];
  bushes: string[];
  rocks: string[];
}

/** The roads, in the order they paint: the dirt roads and trail first, then the town's cobbled streets over them. */
export const ROADS: Road[] = [
  {
    id: 'gen-road-north',
    materialId: 'dirt-path',
    radius: 1.6,
    opacity: 1,
    points: [
      { x: 20.48, z: 0 },
      { x: 20.2, z: -10 },
      { x: 21.2, z: -20 },
      { x: 20.6, z: -30.72 },
    ],
  },
  {
    id: 'gen-trail-north-wood',
    materialId: 'dirt-path',
    radius: 0.6,
    opacity: 0.85,
    points: [
      { x: 20.6, z: -30.72 },
      { x: 19.4, z: -36 },
      { x: 18.2, z: -41.5 },
      { x: 17.4, z: -44.6 },
    ],
  },
  {
    id: 'gen-road-south',
    materialId: 'dirt-path',
    radius: 1.6,
    opacity: 1,
    points: [
      { x: 20.48, z: 40.96 },
      { x: 20.9, z: 51 },
      { x: 19.8, z: 61 },
      { x: 20.3, z: 71.68 },
    ],
  },
  {
    id: 'gen-road-west',
    materialId: 'dirt-path',
    radius: 1.6,
    opacity: 1,
    points: [
      { x: 0, z: 20.48 },
      { x: -10, z: 20.9 },
      { x: -20, z: 19.9 },
      { x: -30.72, z: 20.4 },
    ],
  },
  {
    id: 'gen-road-east',
    materialId: 'dirt-path',
    radius: 1.6,
    opacity: 1,
    points: [
      { x: 40.96, z: 20.48 },
      { x: 52, z: 20.1 },
      { x: 63, z: 21 },
      { x: 74, z: 20.3 },
      { x: 81.92, z: 20.6 },
    ],
  },
  {
    id: 'gen-street-north-south',
    materialId: 'cobble-town',
    radius: 1.6,
    opacity: 1,
    points: [
      { x: 20.48, z: 0 },
      { x: 20.48, z: 40.96 },
    ],
  },
  {
    id: 'gen-street-west-east',
    materialId: 'cobble-town',
    radius: 1.6,
    opacity: 1,
    points: [
      { x: 0, z: 20.48 },
      { x: 40.96, z: 20.48 },
    ],
  },
];

/** How each outdoor door's path to the nearest street is painted; its points are routed from the door itself. */
export const DOOR_PATH = { materialId: 'dirt-path', radius: 0.8, opacity: 0.9 } as const;

/** The square round the well, paved. */
export const PLAZA = { id: 'gen-plaza', materialId: 'cobble-town', centre: { x: 20.48, z: 20.48 }, radius: 3.6 } as const;

/**
 * The splash reel's outdoor figures, walking where `packages/web/src/splash/reel.ts` has them walk
 * and standing where it stands them. The reel's test proves its paths legal against the composed
 * lands, so this list and the reel must move together.
 */
export const SPLASH_KEEP_OUTS: KeepOut[] = [
  {
    radius: 1,
    points: [
      { x: 9, z: 20.5 },
      { x: 16, z: 20.5 },
    ],
  },
  {
    radius: 1,
    points: [
      { x: 23.5, z: 9 },
      { x: 23.5, z: 17 },
      { x: 26, z: 18.5 },
    ],
  },
  {
    radius: 1,
    points: [
      { x: 31, z: 22 },
      { x: 24.5, z: 22 },
    ],
  },
  {
    radius: 1,
    points: [
      { x: 22.5, z: 19 },
      { x: 22.5, z: 9.3 },
      { x: 30, z: 9.3 },
    ],
  },
  { radius: 1.5, points: [{ x: 21.8, z: 22.8 }] },
  {
    radius: 1,
    points: [
      { x: 18.5, z: -50.3 },
      { x: 23, z: -50 },
      { x: 19.77, z: -46.29 },
      { x: 22.5, z: -48.5 },
    ],
  },
  { radius: 1.2, points: [{ x: 19, z: -46.6 }] },
  {
    radius: 1,
    points: [
      { x: 16.5, z: -43.5 },
      { x: 19.65, z: -46.63 },
    ],
  },
];

const MEADOW = {
  clustersPerWindow: 2,
  clusterTrees: [1, 3] as [number, number],
  clusterRadius: 2.2,
  propsPerWindow: 6,
  trees: ['tree-1-a', 'tree-1-b', 'tree-3-a', 'tree-3-b', 'tree-5-a', 'tree-bare-1-a'],
  bushes: ['bush-2-b', 'bush-3-a', 'bush-4-a'],
  rocks: ['rock-1-a', 'rock-3-a'],
};

export const LANDS: LandRules[] = [
  {
    sector: 'AutumnWood',
    seed: 1101,
    clearings: [
      { x: 50, z: 8, radius: 4 },
      { x: 56, z: 33, radius: 3.5 },
    ],
    worn: [
      { x: 57, z: 24, radius: 1.4 },
      { x: 68, z: 17.5, radius: 1.1 },
    ],
    clustersPerWindow: 2.5,
    clusterTrees: [2, 4],
    clusterRadius: 2.6,
    propsPerWindow: 7,
    trees: [
      'autumn-pine-orange-large',
      'autumn-pine-orange-medium',
      'autumn-pine-yellow-large',
      'autumn-pine-yellow-medium',
      'tree-bare-1-a',
      'tree-bare-1-b',
      'pine-tree',
    ],
    bushes: ['bush-2-d'],
    rocks: ['rock-1-d', 'rock-3-a'],
  },
  {
    sector: 'EdariaSquare',
    seed: 1201,
    clearings: [],
    worn: [
      { x: 18.2, z: 8, radius: 1.2 },
      { x: 23, z: 32.5, radius: 1.3 },
      { x: 8, z: 22.5, radius: 1 },
    ],
    clustersPerWindow: 2,
    clusterTrees: [1, 2],
    clusterRadius: 1.6,
    propsPerWindow: 6,
    trees: ['tree-1-a', 'tree-3-a', 'tree-5-a'],
    bushes: ['bush-2-b', 'bush-3-a'],
    rocks: ['rock-1-a'],
  },
  {
    sector: 'NorthMeadow',
    seed: 1301,
    clearings: [
      { x: 12, z: -14, radius: 6 },
      { x: 29, z: -24, radius: 4 },
    ],
    worn: [{ x: 24, z: -12, radius: 1.3 }],
    ...MEADOW,
  },
  {
    sector: 'NorthWood',
    seed: 1401,
    clearings: [{ x: 17, z: -42.5, radius: 3 }],
    worn: [{ x: 17.6, z: -43.6, radius: 1.6 }],
    clustersPerWindow: 2.5,
    clusterTrees: [2, 4],
    clusterRadius: 2.6,
    propsPerWindow: 7,
    trees: ['tree-1-c', 'tree-2-b', 'tree-2-c', 'tree-6-a', 'tree-7-a', 'pine-tree', 'tree-5-a'],
    bushes: ['bush-2-b', 'bush-2-d', 'bush-4-a'],
    rocks: ['rock-1-a', 'rock-1-d', 'rock-3-a'],
  },
  {
    sector: 'SouthMeadow',
    seed: 1501,
    clearings: [
      { x: 12, z: 56, radius: 6 },
      { x: 29, z: 63, radius: 4 },
    ],
    worn: [{ x: 16, z: 47, radius: 1.2 }],
    ...MEADOW,
  },
  {
    sector: 'WestMeadow',
    seed: 1601,
    clearings: [
      { x: -14, z: 12, radius: 6 },
      { x: -24, z: 30, radius: 4 },
    ],
    worn: [{ x: -8, z: 26, radius: 1.2 }],
    ...MEADOW,
  },
];
