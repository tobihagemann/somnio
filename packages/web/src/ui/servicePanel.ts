import {
  COMBAT,
  SHOP,
  TEACHINGS,
  TEACHING_IDS,
  TRIALS,
  TRIAL_REWARDS,
  WARES,
  bagHasRoom,
  canBuy,
  grantPlace,
  isTeachingId,
  masterRole,
  placesFound,
  plainItem,
  practiceNeeded,
  roleLabelKey,
  salePrice,
  sellableItem,
  taskGoal,
  teaching,
  teachingStanding,
  unmetNeed,
} from '@somnio/core';
import type { Inventory, Item, ItemInstance, TaskSpec, TeachingId, TeachingStanding, Ware } from '@somnio/core';
import type { LucidityMessage, NPCService, Role, TaskMessage } from '@somnio/protocol';
import type { ClientEntity } from '@/client';
import { taskIsDone, taskSpecOf } from '@/client';
import { itemName, t } from '@/i18n';
import { button, element, replaceChildren, setHidden } from './dom';
import { itemIcon } from './itemIcons';
import { paintRarityColors } from './hud';
import { itemLines, rarityName } from './itemText';

/**
 * What a master or the shopkeeper offers, opened by a click at them and closed by walking away. It
 * sits beside the world rather than over it: it is no overlay, so the player keeps moving. Every
 * control in it asks the server. The panel shows the outcome once the `lucidity` or `inventory`
 * frame answering it arrives, and a refused request gets no answer.
 */

export interface ServicePanelCallbacks {
  /** Without a teaching, the master's trial; with one, the task that gates it. */
  onAskTask: (teachingId?: string) => void;
  onCompleteTask: () => void;
  onAbandonTask: () => void;
  onStudy: (teachingId: string) => void;
  onBuy: (baseId: string) => void;
  onSell: (itemId: string) => void;
  onClose: () => void;
}

/** Thunks rather than constants so `t` runs after the locale resolves, each key in a literal `t('...')` the catalog test can find. */
const SERVICE_TITLE: Record<NPCService, () => string> = {
  fighterMaster: () => t('Master of the Fighters'),
  healerMaster: () => t('Master of the Healers'),
  mysticMaster: () => t('Master of the Mystics'),
  shopkeeper: () => t('Shopkeeper'),
};

export const TEACHING_BLURB: Record<TeachingId, () => string> = {
  strike: () => t('Each rank adds to every hit you land.'),
  guard: () => t('Each rank makes nightmares miss you more often.'),
  'follow-through': () => t('Each rank shortens the pause between your swings.'),
  'balance-recovery': () => t('Each rank brings your balance back faster.'),
  toughening: () => t('Each rank raises your health by %@.', String(COMBAT.healthPerTougheningRank)),
  cleave: () => t('Strike every nightmare in front of you at once. Each rank hits harder.'),
  challenge: () => t('Turn every nightmare near you on yourself.'),
  brace: () => t('Take half the harm for a few seconds, but you cannot run. Each rank holds it longer.'),
  lunge: () => t('Leap to the nightmare you target. Each rank readies it sooner.'),
  rally: () => t('Shout to give balance back to every dreamer who hears you. Each rank gives back more.'),
  touch: () => t('Holding the Moonstone, target a dreamer or yourself and turn on Mend. Your spirit mends them while they stay near.'),
  depth: () => t('Each rank mends more with every touch.'),
  'drawing-back': () => t('Holding the Moonstone, turn on Mend at a fallen dreamer and stay beside them to raise them.'),
  'spirit-deepening': () => t('Each rank raises your spirit by %@.', String(COMBAT.spiritPerDeepeningRank)),
  'deep-mend': () =>
    t('Stand still and pour a deep mend into the dreamer you target, or into yourself. Moving breaks it off. Each rank mends more, and sooner.'),
  renewal: () => t('Mend the dreamer you target, or yourself, a little every second for a while. Each rank mends more.'),
  radiance: () => t('Mend every dreamer near you at once, yourself included. Each rank mends more.'),
  calm: () => t("Turn the nightmares' anger from you: they forget half of it, and your mending stirs them less for a while."),
  ward: () => t('Shield the dreamer you target, or yourself. The shield takes the harm of the next blows until it breaks. Each rank holds more.'),
  weaken: () => t('The nightmare you target strikes softer for a while. Each rank makes it last longer.'),
  bind: () => t('Hold the nightmare you target where it stands for a few seconds. It still strikes whoever is in its reach. Each rank holds it longer.'),
  'dream-bolt': () => t('Send a bolt of dream at the nightmare you target, even from afar. Each rank hits harder.'),
  veil: () => t('Hide yourself and every dreamer near you from the nightmares for a few seconds. They forget you were there.'),
  'sense-the-fallen': () => t('Always see which way each fallen dreamer lies, however far off.'),
  'mystic-spirit-deepening': () => t('Each rank raises your spirit by %@.', String(COMBAT.spiritPerDeepeningRank)),
};

function roleName(role: Role): string {
  return t(roleLabelKey(role));
}

/** What a task asks for, with the condition it is held under, as the named master sets it. */
function taskText(spec: TaskSpec, master: string): string[] {
  switch (spec.kind) {
    case 'driveOff':
      return [
        spec.count === 1 ? t('Drive off a nightmare.') : t('Drive off %@ nightmares.', String(spec.count)),
        ...(spec.withoutFalling === true ? [t('Falling starts the count over.')] : []),
      ];
    case 'reach':
      return [
        t('Walk to the %@ and come back.', t(spec.labelKey)),
        ...(spec.withoutStriking === true ? [t('You cannot strike while you hold this trial.')] : []),
      ];
    case 'mend':
      return [t('Mend %@ health on other dreamers.', String(spec.amount))];
    case 'reachAll':
      return [t('Find %@ hidden places and come back.', String(spec.places.length)), t('Talk to %@ to hear where they lie.', master)];
  }
}

/**
 * How far a held task has come: a count toward its goal, or for hidden places, how many are found,
 * never which. A task this client cannot read has no line.
 */
export function taskProgressText(task: TaskMessage): string | undefined {
  const spec = taskSpecOf(task);
  if (spec === undefined) return undefined;
  if (spec.kind === 'reachAll') return t('%1$@ of %2$@', String(placesFound(task.progress)), String(spec.places.length));
  return t('%1$@ of %2$@', String(Math.floor(task.progress)), String(taskGoal(spec)));
}

/** The section of the panel a teaching is listed under: where it stands for the dreamer, or that they study it. */
type Standing = TeachingStanding | 'studying';

function standingOf(id: TeachingId, lucidity: LucidityMessage): Standing {
  const standing = teachingStanding(lucidity.ranks, id);
  return standing !== 'mastered' && lucidity.study === id ? 'studying' : standing;
}

function paragraph(text: string, className = 'service-text'): HTMLElement {
  return element('p', { className, text });
}

/** A row of the shop: the item's icon edged and its name in its rarity's colour, with its rarity unless plain, what it does, and the button that trades it. */
function tradeRow(attributes: Record<string, string>, item: Item, notes: readonly HTMLElement[], action: HTMLButtonElement): HTMLElement {
  const icon = itemIcon(item.baseId);
  icon.classList.add('ware-icon', `hud-rarity--${item.rarity}`);
  return element('div', {
    className: 'ware-row',
    attributes,
    children: [
      element('div', {
        className: 'ware-head',
        children: [
          icon,
          element('strong', { className: `ware-name hud-rarity--${item.rarity}`, text: itemName(item.baseId, t) }),
          ...(item.rarity === 'plain' ? [] : [element('span', { className: 'ware-tag', text: rarityName(item.rarity) })]),
        ],
      }),
      ...itemLines(item).map((line) => paragraph(line)),
      ...notes,
      element('div', { className: 'ware-action', children: [action] }),
    ],
  });
}

export class ServicePanel {
  readonly root: HTMLElement;

  private readonly callbacks: ServicePanelCallbacks;
  private readonly title: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly purse: HTMLElement;
  private readonly purseAmount: HTMLElement;
  private readonly body: HTMLElement;
  private shown: { npcId: string; reads: readonly unknown[] } | undefined;

  constructor(callbacks: ServicePanelCallbacks) {
    this.callbacks = callbacks;
    this.title = element('h1', { className: 'overlay-title' });
    this.subtitle = element('p', { className: 'form-note service-subtitle' });
    this.purseAmount = element('strong');
    // Above the scrolling body, so what the dreamer can afford stays in view however far the wares are scrolled.
    this.purse = element('p', { className: 'shop-purse', children: [element('span', { text: t('Your purse') }), this.purseAmount] });
    this.body = element('div', { className: 'service-body' });
    this.root = element('section', {
      className: 'fantasy-panel service-panel hidden',
      children: [
        this.title,
        this.subtitle,
        this.purse,
        this.body,
        element('div', { className: 'form-actions', children: [button(t('Close'), () => callbacks.onClose())] }),
      ],
    });
    paintRarityColors(this.root);
  }

  render(npc: ClientEntity | undefined, lucidity: LucidityMessage, inventory: Inventory, tradeLocked: boolean): void {
    const service = npc?.service;
    setHidden(this.root, service === undefined);
    if (npc === undefined || service === undefined) {
      this.shown = undefined;
      return;
    }
    // The shell renders on every state change, each `energy` frame of a recovering pool included,
    // and a button replaced while the pointer is held on it never gets its click.
    const { reads, purse, build } = this.bodyFor(npc, service, lucidity, inventory, tradeLocked);
    const shown = this.shown;
    if (shown?.npcId === npc.id && reads.every((read, index) => read === shown.reads[index])) return;
    this.shown = { npcId: npc.id, reads };
    this.root.setAttribute('aria-label', npc.name);
    this.title.textContent = npc.name;
    this.subtitle.textContent = SERVICE_TITLE[service]();
    setHidden(this.purse, purse === undefined);
    if (purse !== undefined) this.purseAmount.textContent = t('%@c', String(purse));
    replaceChildren(this.body, build());
  }

  /** The body a service shows, with the inputs it reads, so a frame it does not read leaves it standing. The shopkeeper's also carries the purse shown above it. */
  private bodyFor(
    npc: ClientEntity,
    service: NPCService,
    lucidity: LucidityMessage,
    inventory: Inventory,
    tradeLocked: boolean,
  ): { reads: readonly unknown[]; purse?: number; build: () => HTMLElement[] } {
    switch (service) {
      case 'fighterMaster':
      case 'healerMaster':
      case 'mysticMaster': {
        const role = masterRole(service);
        const reward = TRIAL_REWARDS[role];
        // Of what the dreamer carries, a master reads only whether the trial's reward has a place to go.
        const rewardFits = reward === undefined || grantPlace(inventory, reward) !== undefined;
        return { reads: [lucidity, rewardFits], build: () => this.master(npc, role, lucidity, rewardFits) };
      }
      case 'shopkeeper':
        return { reads: [inventory, tradeLocked], purse: inventory.coins, build: () => this.shop(npc, inventory, tradeLocked) };
    }
  }

  /** Every ware, to buy, and every item in the dreamer's bag the shopkeeper buys, to sell. Every button is disabled while a trade holds the lock. */
  private shop(npc: ClientEntity, inventory: Inventory, tradeLocked: boolean): HTMLElement[] {
    const sellable = inventory.bag.flatMap(({ item }) => sellableItem(inventory, item.id) ?? []);
    return [
      paragraph(t('%@ sells plain gear and buys what you find. Rarer finds fetch more.', npc.name)),
      element('h2', { className: 'service-heading', text: t('For sale') }),
      ...WARES.map((ware) => this.wareRow(ware, inventory, tradeLocked)),
      element('h2', { className: 'service-heading', text: t('Sell') }),
      ...(sellable.length === 0
        ? [paragraph(t('Your bag holds nothing %@ buys.', npc.name), 'form-note')]
        : sellable.map((item) => this.saleRow(item, tradeLocked))),
    ];
  }

  /** A ware to buy, a plain one at its base's tier. */
  private wareRow(ware: Ware, inventory: Inventory, tradeLocked: boolean): HTMLElement {
    const price = SHOP.prices[ware];
    const short = price - inventory.coins;
    const action = button(t('Buy for %@c', String(price)), () => this.callbacks.onBuy(ware));
    // Several wares share a price, so the button's accessible name says which one it buys.
    action.setAttribute('aria-label', t('Buy %1$@ for %2$@c', itemName(ware, t), String(price)));
    action.disabled = tradeLocked || !canBuy(inventory, ware);
    let notes: HTMLElement[] = [];
    if (short > 0) notes = [paragraph(t('You need %@c more.', String(short)), 'form-note')];
    else if (!bagHasRoom(inventory)) notes = [paragraph(t('Your bag is full.'), 'form-note')];
    return tradeRow({ 'data-ware': ware }, plainItem(ware), notes, action);
  }

  /** An item in the bag to sell, for what its tier and rarity fetch. */
  private saleRow(item: ItemInstance, tradeLocked: boolean): HTMLElement {
    const action = button(t('Sell for %@c', String(salePrice(item))), () => this.callbacks.onSell(item.id));
    action.setAttribute('aria-label', t('Sell %1$@ for %2$@c', itemName(item.baseId, t), String(salePrice(item))));
    action.disabled = tradeLocked;
    return tradeRow({ 'data-item': item.id }, item, [], action);
  }

  private master(npc: ClientEntity, role: Role, lucidity: LucidityMessage, rewardFits: boolean): HTMLElement[] {
    if (lucidity.role === undefined) return this.trial(npc, role, lucidity.task, rewardFits);
    if (lucidity.role !== role) return [paragraph(t('You are a %1$@. %2$@ has nothing to teach you.', roleName(lucidity.role), npc.name))];
    const ids = TEACHING_IDS.filter((id) => TEACHINGS[id].role === role);
    const section = (standing: Standing, heading: string): HTMLElement[] => {
      const rows = ids.filter((id) => standingOf(id, lucidity) === standing).map((id) => this.teachingRow(npc, id, standing, lucidity));
      return rows.length === 0 ? [] : [element('h2', { className: 'service-heading', text: heading }), ...rows];
    };
    const studying = section('studying', t('You are studying'));
    return [
      paragraph(t('You study one teaching at a time. What you do out there fills its practice, and full practice is its next rank.')),
      ...(studying.length === 0 ? [paragraph(t('You study nothing. Choose a teaching below.'))] : studying),
      ...section('open', t('You can study')),
      ...section('task', t('Earned by a task')),
      ...section('later', t('Not yet')),
      ...section('mastered', t('Mastered')),
    ];
  }

  /** A dreamer with no role yet: the offer, the trial under way, or the choice it earned, which waits while what it gives has nowhere to go. */
  private trial(npc: ClientEntity, role: Role, task: TaskMessage | undefined, rewardFits: boolean): HTMLElement[] {
    if (task === undefined) {
      return [
        paragraph(
          t(
            '%1$@ takes on those who pass a trial. Passing it commits you to nothing: you choose afterwards whether to become a %2$@.',
            npc.name,
            roleName(role),
          ),
        ),
        ...taskText(TRIALS[role], npc.name).map((line) => paragraph(line, 'form-note')),
        button(t('Ask for the trial'), () => this.callbacks.onAskTask()),
      ];
    }
    if (task.role !== role) {
      return [paragraph(t("You hold another master's trial. One trial at a time.")), button(t('Give up that trial'), () => this.callbacks.onAbandonTask())];
    }
    if (!taskIsDone(task)) {
      return [
        element('h2', { className: 'service-heading', text: t('Your trial') }),
        ...this.taskLines(npc, task),
        button(t('Give up the trial'), () => this.callbacks.onAbandonTask()),
      ];
    }
    const accept = button(t('Become a %@', roleName(role)), () => this.callbacks.onCompleteTask());
    accept.disabled = !rewardFits;
    return [
      element('h2', { className: 'service-heading', text: t('Become a %@?', roleName(role)) }),
      paragraph(
        t('You passed the trial. Accepting makes you a %@ for good. It cannot be undone, and the other masters will not teach you afterwards.', roleName(role)),
      ),
      ...(rewardFits ? [] : [paragraph(t('Your bag is full. Make room in it before you accept.'), 'form-error')]),
      element('div', { className: 'form-actions', children: [button(t('Not yet'), () => this.callbacks.onClose()), accept] }),
    ];
  }

  private taskLines(npc: ClientEntity, task: TaskMessage): HTMLElement[] {
    const spec = taskSpecOf(task);
    const progress = taskProgressText(task);
    if (spec === undefined || progress === undefined) return [];
    const [what, ...conditions] = taskText(spec, npc.name);
    return [paragraph(`${what} ${progress}`), ...conditions.map((line) => paragraph(line, 'form-note'))];
  }

  private teachingRow(npc: ClientEntity, id: TeachingId, standing: Standing, lucidity: LucidityMessage): HTMLElement {
    const taught = teaching(id);
    const held = lucidity.ranks.find((rank) => rank.teachingId === id);
    const rank = held?.rank ?? 0;
    let notes: HTMLElement[] = [];
    let action: HTMLElement | undefined;
    switch (standing) {
      case 'studying': {
        const practice = String(Math.floor(held?.practice ?? 0));
        notes = [paragraph(t('%1$@ of %2$@ practice toward rank %3$@', practice, String(practiceNeeded(rank)), String(rank + 1)), 'form-note')];
        break;
      }
      case 'open':
        action = button(t('Study this'), () => this.callbacks.onStudy(id));
        break;
      case 'task':
        ({ notes, action } = this.gate(npc, id, lucidity.task));
        break;
      case 'later': {
        const needs = unmetNeed(lucidity.ranks, id);
        if (needs !== undefined && isTeachingId(needs.teachingId)) {
          notes = [paragraph(t('Needs %1$@ at rank %2$@', t(teaching(needs.teachingId).labelKey), String(needs.rank)), 'form-note')];
        }
        break;
      }
      case 'mastered':
        break;
    }

    return element('div', {
      className: 'teaching-row',
      attributes: { 'data-teaching': id },
      children: [
        element('div', {
          className: 'teaching-head',
          children: [
            element('strong', { text: t(taught.labelKey) }),
            element('span', { className: 'teaching-rank', text: t('Rank %1$@ of %2$@', String(rank), String(taught.maxRank)) }),
          ],
        }),
        paragraph(TEACHING_BLURB[id](), 'service-text'),
        ...notes,
        ...(action === undefined ? [] : [element('div', { className: 'teaching-action', children: [action] })]),
      ],
    });
  }

  /** A teaching whose first rank is earned by a task: what the task asks and the way to take it, the task under way, or the rank it earned. */
  private gate(npc: ClientEntity, id: TeachingId, task: TaskMessage | undefined): { notes: HTMLElement[]; action: HTMLElement | undefined } {
    if (task?.teachingId !== id) {
      const asks = [
        paragraph(t('%@ teaches its first rank for a task.', npc.name), 'form-note'),
        ...taskText(teaching(id).gate!, npc.name).map((line) => paragraph(line, 'form-note')),
      ];
      return task === undefined
        ? { notes: asks, action: button(t('Take the task'), () => this.callbacks.onAskTask(id)) }
        : { notes: [...asks, paragraph(t('Finish your current task first.'), 'form-error')], action: undefined };
    }
    if (taskIsDone(task)) {
      return {
        notes: [paragraph(t('You did what %@ asked.', npc.name), 'form-note')],
        action: button(t('Learn %@', t(teaching(id).labelKey)), () => this.callbacks.onCompleteTask()),
      };
    }
    return { notes: this.taskLines(npc, task), action: button(t('Give up the task'), () => this.callbacks.onAbandonTask()) };
  }
}
