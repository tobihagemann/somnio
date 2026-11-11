import {
  COMBAT,
  NO_LUCIDITY,
  balancePerSecond,
  maxPools,
  mendAmount,
  monsterKind,
  spiritPerSecond,
  statsOf,
  strikeChance,
  swingFor,
  wardShare,
} from '@somnio/core';
import type { Inventory, StatId } from '@somnio/core';
import type { LucidityMessage } from '@somnio/protocol';
import { itemName, t } from '@/i18n';
import { decimal } from './belt';
import { statLine } from './itemText';

/** One line of the Stats tab: what it measures, its whole total, and where that comes from. */
interface StatRow {
  /** Names the line from one showing to the next, so a total that changed can be marked. */
  key: string;
  label: string;
  value: string;
  note?: string;
}

export interface StatGroup {
  title: string;
  rows: StatRow[];
}

/** The nightmare the Defence lines measure strikes against, the one Edaria's lands start with. */
const MEASURED_NIGHTMARE = monsterKind('ghost');

function percent(share: number): string {
  return t('%@%%', String(Math.round(share * 100)));
}

/**
 * The dreamer's whole totals as the rules read them, from their ranks and what they wear: the pools,
 * the swing, how often a nightmare's strike lands, recovery, and a Healer's mend or a Mystic's ward.
 */
export function statGroups(inventory: Inventory, lucidity: LucidityMessage): StatGroup[] {
  const stats = statsOf(inventory.equipped, lucidity);
  const fromRanks = statsOf({}, lucidity);
  const fromGear = statsOf(inventory.equipped, NO_LUCIDITY);
  const pools = maxPools(stats);
  const sources = (stat: StatId): string | undefined => {
    const parts = [
      ...(fromRanks[stat] === 0 ? [] : [t('+%@ ranks', String(fromRanks[stat]))]),
      ...(fromGear[stat] === 0 ? [] : [t('+%@ gear', String(fromGear[stat]))]),
    ];
    return parts.length === 0 ? undefined : parts.join(' · ');
  };
  const added = (stat: StatId): string | undefined => (stats[stat] === 0 ? undefined : statLine(stat, stats[stat]));
  const { mainHand } = inventory.equipped;
  const swing = swingFor(mainHand, stats);
  const groups: StatGroup[] = [
    {
      title: t('Pools'),
      rows: [
        row('health', t('Health'), String(pools.healthMax), sources('healthMax')),
        row('spirit', t('Spirit'), String(pools.spiritMax), sources('spiritMax')),
        row('balance', t('Balance'), String(pools.balanceMax), sources('balanceMax')),
      ],
    },
    {
      title: t('Offence'),
      rows:
        swing === undefined
          ? []
          : [
              row(
                'damage',
                t('Damage a swing'),
                String(swing.damage),
                [
                  t('%1$@: %2$@', mainHand === undefined ? t('Bare hands') : itemName(mainHand.baseId, t), String(swing.damage - stats.damage)),
                  sources('damage'),
                ]
                  .filter((part) => part !== undefined)
                  .join(' · '),
              ),
              row('interval', t('Time between swings'), t('%@ s', decimal(swing.seconds)), added('swingSpeed')),
              row('cost', t('Balance a swing'), String(swing.balanceCost)),
              row('hit', t('Your swings land'), percent(COMBAT.hitChance)),
            ],
    },
    {
      title: t('Defence'),
      rows: [
        row('guard', t('Guard'), String(stats.guard), sources('guard')),
        row(
          'struck',
          t('%@ strikes land', t(MEASURED_NIGHTMARE.name)),
          percent(strikeChance(MEASURED_NIGHTMARE, pools.balanceMax, pools.balanceMax, stats)),
          t('%1$@ − %2$@ Guard', percent(MEASURED_NIGHTMARE.hitChance), percent(COMBAT.hitChancePerGuard * stats.guard)),
        ),
        row('struckUnsteady', t('...with no Balance left'), percent(strikeChance(MEASURED_NIGHTMARE, 0, pools.balanceMax, stats))),
      ],
    },
    {
      title: t('Recovery'),
      rows: [
        row('healthRecovery', t('Health a second'), decimal(COMBAT.healthPerSecond)),
        row('balanceRecovery', t('Balance a second'), decimal(balancePerSecond(stats)), added('balanceRecovery')),
        row('spiritRecovery', t('Spirit a second'), decimal(spiritPerSecond(stats)), added('spiritRecovery')),
      ],
    },
  ];
  if (lucidity.role === 'healer')
    groups.push({ title: t('Mending'), rows: [row('mend', t('Health a mend'), String(mendAmount(stats)), sources('mendDepth'))] });
  if (lucidity.role === 'mystic')
    groups.push({ title: t('Warding'), rows: [row('ward', t('Ward strength'), percent(wardShare(stats)), added('wardStrength'))] });
  return groups;
}

function row(key: string, label: string, value: string, note?: string): StatRow {
  return { key, label, value, ...(note === undefined || note === '' ? {} : { note }) };
}
