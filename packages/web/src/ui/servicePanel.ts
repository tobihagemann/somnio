import {
  COMBAT,
  QUEST_IDS,
  SHOP,
  TEACHINGS,
  TEACHING_IDS,
  TRIAL_QUESTS,
  TRIAL_REWARDS,
  WARES,
  bagHasRoom,
  bountyIdOf,
  bountyQuest,
  canBuy,
  gatedTeaching,
  grantPlace,
  heldQuest,
  isTeachingId,
  masterRole,
  mayAccept,
  plainItem,
  practiceNeeded,
  quest,
  questCarriedBy,
  questComplete,
  questLogFull,
  roleLabelKey,
  salePrice,
  sellableItem,
  teaching,
  teachingStanding,
  trialRole,
  turnInFor,
  unmetNeed,
} from '@somnio/core';
import type {
  ActiveQuest,
  Bounty,
  Inventory,
  Item,
  ItemInstance,
  QuestId,
  QuestLog,
  QuestOrBountyId,
  QuestCarrier,
  QuestReward,
  TeachingId,
  TeachingStanding,
  Ware,
} from '@somnio/core';
import type { LucidityMessage, Role, Service } from '@somnio/protocol';
import type { ServiceCarrier } from '@/client';
import { itemName, t } from '@/i18n';
import { button, element, replaceChildren, setHidden } from './dom';
import { itemIcon } from './itemIcons';
import { paintRarityColors } from './hud';
import { itemLines, rarityName } from './itemText';
import { questAsks, questLines, questTitle, rewardNote } from './questText';

/**
 * What a carrier offers: a master, the shopkeeper, or the bounty board, and the quests a carrier
 * gives or takes, opened by a press at it and closed by walking away. It sits beside the world
 * rather than over it: it is no overlay, so the player keeps moving. Every control in it asks the
 * server. The panel shows the outcome once the frame answering it arrives, and a refused request
 * gets no answer.
 */

export interface ServicePanelCallbacks {
  onAcceptQuest: (questId: QuestOrBountyId) => void;
  onTurnInQuest: (questId: QuestOrBountyId) => void;
  onAbandonQuest: (questId: QuestOrBountyId) => void;
  onStudy: (teachingId: string) => void;
  onBuy: (baseId: string) => void;
  onSell: (itemId: string) => void;
  onClose: () => void;
}

/** Thunks rather than constants so `t` runs after the locale resolves, each key in a literal `t('...')` the catalog test can find. */
const SERVICE_TITLE: Record<Service, () => string> = {
  fighterMaster: () => t('Master of the Fighters'),
  healerMaster: () => t('Master of the Healers'),
  mysticMaster: () => t('Master of the Mystics'),
  shopkeeper: () => t('Shopkeeper'),
  bountyBoard: () => t('Bounty board'),
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

/** The section of the panel a teaching is listed under: where it stands for the dreamer, or that they study it. */
type Standing = TeachingStanding | 'studying';

function standingOf(id: TeachingId, lucidity: LucidityMessage): Standing {
  const standing = teachingStanding(lucidity.ranks, id);
  return standing !== 'mastered' && lucidity.study === id ? 'studying' : standing;
}

function paragraph(text: string, className = 'service-text'): HTMLElement {
  return element('p', { className, text });
}

/** A row's button, at the row's trailing edge as every row of the panel has it. */
function actionRow(action: HTMLElement): HTMLElement {
  return element('div', { className: 'teaching-action', children: [action] });
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
  private shown: { carrierId: string; reads: readonly unknown[] } | undefined;

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

  /** Whether the panel shows a carrier's offer. */
  get open(): boolean {
    return this.shown !== undefined;
  }

  render(
    carrier: ServiceCarrier | undefined,
    lucidity: LucidityMessage,
    quests: QuestLog,
    bounties: readonly Bounty[],
    inventory: Inventory,
    tradeLocked: boolean,
  ): void {
    setHidden(this.root, carrier === undefined);
    if (carrier === undefined) {
      this.shown = undefined;
      return;
    }
    // An NPC goes by its name over what it does; a fixture goes by its service alone.
    const serviceTitle = carrier.service === undefined ? undefined : SERVICE_TITLE[carrier.service]();
    const name = carrier.name ?? serviceTitle ?? '';
    // The shell renders on every state change, each `energy` frame of a recovering pool included,
    // and a button replaced while the pointer is held on it never gets its click.
    const { reads, purse, build } = this.bodyFor(carrier, name, lucidity, quests, bounties, inventory, tradeLocked);
    const shown = this.shown;
    if (shown?.carrierId === carrier.id && reads.every((read, index) => read === shown.reads[index])) return;
    this.shown = { carrierId: carrier.id, reads };
    const subtitle = carrier.name === undefined ? undefined : serviceTitle;
    this.root.setAttribute('aria-label', name);
    this.title.textContent = name;
    setHidden(this.subtitle, subtitle === undefined);
    this.subtitle.textContent = subtitle ?? '';
    setHidden(this.purse, purse === undefined);
    if (purse !== undefined) this.purseAmount.textContent = t('%@c', String(purse));
    replaceChildren(this.body, build());
  }

  /**
   * The body a carrier shows, with the inputs it reads, so a frame it does not read leaves it
   * standing: its own service's, then the quests it gives or takes that no master's teachings show.
   * The shopkeeper's also carries the purse shown above it.
   */
  private bodyFor(
    carrier: ServiceCarrier,
    name: string,
    lucidity: LucidityMessage,
    quests: QuestLog,
    bounties: readonly Bounty[],
    inventory: Inventory,
    tradeLocked: boolean,
  ): { reads: readonly unknown[]; purse?: number; build: () => HTMLElement[] } {
    const own =
      carrier.service === undefined ? undefined : this.serviceBody(carrier, name, carrier.service, lucidity, quests, bounties, inventory, tradeLocked);
    const carries = QUEST_IDS.some((questId) => questCarriedBy(quest(questId).giver, carrier) || questCarriedBy(quest(questId).turnIn, carrier));
    if (own !== undefined && !carries) return own;
    // Of what the dreamer carries, the quests read only whether a reward's item has a place to go.
    const roomForGear = bagHasRoom(inventory);
    const build = (): HTMLElement[] => [...(own?.build() ?? []), ...this.questOffers(carrier, name, lucidity, quests, roomForGear)];
    return { reads: [...(own?.reads ?? []), lucidity, quests, roomForGear], ...(own?.purse === undefined ? {} : { purse: own.purse }), build };
  }

  private serviceBody(
    carrier: QuestCarrier,
    name: string,
    service: Service,
    lucidity: LucidityMessage,
    quests: QuestLog,
    bounties: readonly Bounty[],
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
        return { reads: [lucidity, quests, rewardFits], build: () => this.master(carrier, name, role, lucidity, quests, rewardFits) };
      }
      case 'shopkeeper':
        return { reads: [inventory, tradeLocked], purse: inventory.coins, build: () => this.shop(name, inventory, tradeLocked) };
      case 'bountyBoard': {
        // Of what the dreamer carries, the board reads only whether a bounty's item has a place to go.
        const roomForGear = bagHasRoom(inventory);
        return { reads: [lucidity, quests, bounties, roomForGear], build: () => this.bountyBoard(lucidity, quests, bounties, roomForGear) };
      }
    }
  }

  /**
   * The day's bounties. The bounties the dreamer took on an earlier day, which the board still pays
   * for, come first under a heading of their own, since one may be set in the same land as the day's.
   */
  private bountyBoard(lucidity: LucidityMessage, quests: QuestLog, bounties: readonly Bounty[], roomForGear: boolean): HTMLElement[] {
    const offered = new Set(bounties.map(bountyIdOf));
    const earlier = quests.active.flatMap((held) => (held.definition === undefined || offered.has(held.questId) ? [] : [held.definition]));
    if (earlier.length === 0 && bounties.length === 0) return [paragraph(t('No bounties today.'), 'form-note')];
    const today = bounties.map((bounty) => this.bountyRow(bounty, lucidity, quests, roomForGear, false));
    if (earlier.length === 0) return [paragraph(t('New bounties go up each day.')), ...today];
    return [
      paragraph(t('New bounties go up each day.')),
      element('h2', { className: 'service-heading', text: t('Taken on an earlier day') }),
      ...earlier.map((bounty) => this.bountyRow(bounty, lucidity, quests, roomForGear, true)),
      element('h2', { className: 'service-heading', text: t("Today's bounties") }),
      ...(today.length === 0 ? [paragraph(t('No bounties today.'), 'form-note')] : today),
    ];
  }

  /**
   * A bounty: what it asks and pays, and the way to take it, how far it has come, the way to turn it
   * in once done, or that it is turned in. Bounties share a title per land, so each button's
   * accessible name also says what the bounty asks, and whether it was taken on an earlier day.
   */
  private bountyRow(bounty: Bounty, lucidity: LucidityMessage, quests: QuestLog, roomForGear: boolean, earlier: boolean): HTMLElement {
    const questId = bountyIdOf(bounty);
    const held = quests.active.find((candidate) => candidate.questId === questId);
    // A bounty held is said as it was taken on: its id leaves out its count and its reward, which
    // the day's offer of it may have changed since, as the spawns did.
    const taken = held?.definition ?? bounty;
    const said = bountyQuest(taken);
    const title = questTitle(said, taken);
    if (quests.done.includes(questId)) return this.questRow(questId, title, [], undefined, t('Turned in'));
    if (held === undefined) {
      const take = this.offerButton(t('Take the bounty'), questId, quests);
      take.setAttribute('aria-label', t('Take %1$@. %2$@', title, questAsks(said)));
      return this.questRow(questId, title, [...questLines(said, undefined), ...rewardNote(said.reward, lucidity.study), ...this.logFullNote(quests)], take);
    }
    if (turnInFor(questId, quests, lucidity) === undefined) {
      return this.questRow(questId, title, [...questLines(said, held), ...rewardNote(said.reward, lucidity.study)], undefined, t('Taken'));
    }
    const name = earlier ? t('Turn in %1$@ from an earlier day. %2$@', title, questAsks(said)) : t('Turn in %1$@. %2$@', title, questAsks(said));
    return this.questRow(
      questId,
      title,
      [...questLines(said, held), ...this.turnInNotes(said.reward, lucidity.study, roomForGear)],
      this.turnInButton(held, name, said.reward, roomForGear),
      t('Done'),
    );
  }

  /**
   * The quests the carrier gives that the dreamer may take on, and those they hold that it gives or
   * takes, each with what it asks and pays. A trial and a teaching's task are a master's teachings,
   * shown there.
   */
  private questOffers(carrier: QuestCarrier, name: string, lucidity: LucidityMessage, quests: QuestLog, roomForGear: boolean): HTMLElement[] {
    const ownQuest = (questId: QuestId): boolean => trialRole(questId) === undefined && gatedTeaching(questId) === undefined;
    const offered = QUEST_IDS.filter((questId) => ownQuest(questId) && questCarriedBy(quest(questId).giver, carrier) && mayAccept(questId, quests, lucidity));
    const held = quests.active.filter(
      (active) =>
        active.definition === undefined &&
        ownQuest(active.questId) &&
        (questCarriedBy(quest(active.questId).giver, carrier) || questCarriedBy(quest(active.questId).turnIn, carrier)),
    );
    return [
      ...held.map((active) => this.heldQuestRow(carrier, name, active, quests, lucidity, roomForGear)),
      ...offered.map((questId) =>
        this.questRow(
          questId,
          questTitle(quest(questId)),
          [...questLines(quest(questId), undefined), ...rewardNote(quest(questId).reward, lucidity.study), ...this.logFullNote(quests)],
          this.offerButton(t('Take the quest'), questId, quests),
        ),
      ),
    ];
  }

  /** A quest held: how far it has come, and the way to turn it in once it is done here, greyed out while the item it pays has nowhere to go. */
  private heldQuestRow(carrier: QuestCarrier, name: string, held: ActiveQuest, quests: QuestLog, lucidity: LucidityMessage, roomForGear: boolean): HTMLElement {
    const said = heldQuest(held);
    const title = questTitle(said);
    if (!questCarriedBy(said.turnIn, carrier) || turnInFor(held.questId, quests, lucidity) === undefined) {
      return this.questRow(held.questId, title, questLines(said, held), undefined);
    }
    const notes = [paragraph(t('You did what %@ asked.', name), 'form-note'), ...this.turnInNotes(said.reward, lucidity.study, roomForGear)];
    return this.questRow(held.questId, title, notes, this.turnInButton(held, t('Turn in %@', title), said.reward, roomForGear));
  }

  /** What a quest done pays, and that the bag is full while the item it pays has nowhere to go. */
  private turnInNotes(reward: QuestReward | undefined, study: string | undefined, roomForGear: boolean): HTMLElement[] {
    const fits = reward?.gear === undefined || roomForGear;
    return [...rewardNote(reward, study), ...(fits ? [] : [paragraph(t('Your bag is full. Make room in it before you turn this in.'), 'form-error')])];
  }

  /** The button that turns a quest done in, under its accessible `name`, greyed out while the item it pays has nowhere to go. */
  private turnInButton(held: ActiveQuest, name: string, reward: QuestReward | undefined, roomForGear: boolean): HTMLButtonElement {
    const action = button(t('Turn in'), () => this.callbacks.onTurnInQuest(held.questId));
    action.setAttribute('aria-label', name);
    action.disabled = reward?.gear !== undefined && !roomForGear;
    return action;
  }

  /** A quest's row, under its title and, for a bounty, where it stands. */
  private questRow(questId: QuestOrBountyId, title: string, notes: readonly HTMLElement[], action: HTMLElement | undefined, standing?: string): HTMLElement {
    return element('div', {
      className: 'teaching-row',
      attributes: { 'data-quest': questId },
      children: [
        element('div', {
          className: 'teaching-head',
          children: [element('strong', { text: title }), ...(standing === undefined ? [] : [element('span', { className: 'teaching-rank', text: standing })])],
        }),
        ...notes,
        ...(action === undefined ? [] : [actionRow(action)]),
      ],
    });
  }

  /** Every ware, to buy, and every item in the dreamer's bag the shopkeeper buys, to sell. Every button is disabled while a trade holds the lock. */
  private shop(name: string, inventory: Inventory, tradeLocked: boolean): HTMLElement[] {
    const sellable = inventory.bag.flatMap(({ item }) => sellableItem(inventory, item.id) ?? []);
    return [
      paragraph(t('%@ sells plain gear and buys what you find. Rarer finds fetch more.', name)),
      element('h2', { className: 'service-heading', text: t('For sale') }),
      ...WARES.map((ware) => this.wareRow(ware, inventory, tradeLocked)),
      element('h2', { className: 'service-heading', text: t('Sell') }),
      ...(sellable.length === 0
        ? [paragraph(t('Your bag holds nothing %@ buys.', name), 'form-note')]
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

  /**
   * A master's teachings, its trial among them. Only the carrier a trial or a task names as its
   * giver offers it, and only the one it names as its turn-in takes it, as the server judges both.
   */
  private master(carrier: QuestCarrier, name: string, role: Role, lucidity: LucidityMessage, quests: QuestLog, rewardFits: boolean): HTMLElement[] {
    if (lucidity.role === undefined) return this.trial(carrier, name, role, quests, rewardFits);
    if (lucidity.role !== role) return [paragraph(t('You are a %1$@. %2$@ has nothing to teach you.', roleName(lucidity.role), name))];
    const ids = TEACHING_IDS.filter((id) => TEACHINGS[id].role === role);
    const section = (standing: Standing, heading: string): HTMLElement[] => {
      const rows = ids.filter((id) => standingOf(id, lucidity) === standing).map((id) => this.teachingRow(carrier, name, id, standing, lucidity, quests));
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
  private trial(carrier: QuestCarrier, name: string, role: Role, quests: QuestLog, rewardFits: boolean): HTMLElement[] {
    const own = TRIAL_QUESTS[role];
    const held = quests.active.find((candidate) => trialRole(candidate.questId) !== undefined);
    if (held === undefined) {
      const gives = questCarriedBy(quest(own).giver, carrier);
      return [
        paragraph(
          t('%1$@ takes on those who pass a trial. Passing it commits you to nothing: you choose afterwards whether to become a %2$@.', name, roleName(role)),
        ),
        ...questLines(quest(own), undefined),
        ...(gives ? [...this.logFullNote(quests), actionRow(this.offerButton(t('Ask for the trial'), own, quests))] : []),
      ];
    }
    if (held.questId !== own) {
      return [
        paragraph(t("You hold another master's trial. One trial at a time.")),
        actionRow(button(t('Give up that trial'), () => this.callbacks.onAbandonQuest(held.questId))),
      ];
    }
    if (!questComplete(held) || !questCarriedBy(quest(own).turnIn, carrier)) {
      return [
        element('h2', { className: 'service-heading', text: t('Your trial') }),
        ...questLines(quest(own), held),
        actionRow(button(t('Give up the trial'), () => this.callbacks.onAbandonQuest(own))),
      ];
    }
    const accept = button(t('Become a %@', roleName(role)), () => this.callbacks.onTurnInQuest(own));
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

  /** The button that takes a quest on, greyed out while the quest log is full. */
  private offerButton(label: string, questId: QuestOrBountyId, quests: QuestLog): HTMLButtonElement {
    const offer = button(label, () => this.callbacks.onAcceptQuest(questId));
    offer.disabled = questLogFull(quests);
    return offer;
  }

  private logFullNote(quests: QuestLog): HTMLElement[] {
    return questLogFull(quests) ? [paragraph(t('Your quest log is full. Give up a quest to take this one.'), 'form-error')] : [];
  }

  private teachingRow(carrier: QuestCarrier, name: string, id: TeachingId, standing: Standing, lucidity: LucidityMessage, quests: QuestLog): HTMLElement {
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
        ({ notes, action } = this.gate(carrier, name, id, quests));
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
        ...(action === undefined ? [] : [actionRow(action)]),
      ],
    });
  }

  /** A teaching whose first rank is earned by a task: what the task asks and the way to take it, the task under way, or the rank it earned. */
  private gate(carrier: QuestCarrier, name: string, id: TeachingId, quests: QuestLog): { notes: HTMLElement[]; action: HTMLElement | undefined } {
    const questId = teaching(id).gate!;
    const held = quests.active.find((candidate) => candidate.questId === questId);
    if (held === undefined) {
      const gives = questCarriedBy(quest(questId).giver, carrier);
      return {
        notes: [
          paragraph(t('%@ teaches its first rank for a task.', name), 'form-note'),
          ...questLines(quest(questId), undefined),
          ...(gives ? this.logFullNote(quests) : []),
        ],
        action: gives ? this.offerButton(t('Take the task'), questId, quests) : undefined,
      };
    }
    if (questComplete(held) && questCarriedBy(quest(questId).turnIn, carrier)) {
      return {
        notes: [paragraph(t('You did what %@ asked.', name), 'form-note')],
        action: button(t('Learn %@', t(teaching(id).labelKey)), () => this.callbacks.onTurnInQuest(questId)),
      };
    }
    return { notes: questLines(quest(questId), held), action: button(t('Give up the task'), () => this.callbacks.onAbandonQuest(questId)) };
  }
}
