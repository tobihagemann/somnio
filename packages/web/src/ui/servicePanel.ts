import {
  COMBAT,
  ITEMS,
  SHOP,
  TEACHINGS,
  TEACHING_IDS,
  TRIALS,
  WARES,
  buyBackPrice,
  canBuy,
  canSell,
  isTeachingId,
  itemInHand,
  masterRole,
  practiceNeeded,
  purseCoins,
  roleLabelKey,
  taskGoal,
  teaching,
  teachingStanding,
  unmetNeed,
} from '@somnio/core';
import type { TaskSpec, TeachingId, TeachingStanding, Ware } from '@somnio/core';
import type { InventoryRowMessage, LucidityMessage, NPCService, Role, TaskMessage } from '@somnio/protocol';
import type { ClientEntity } from '@/client';
import { taskIsDone, taskSpecOf } from '@/client';
import { t } from '@/i18n';
import { button, element, replaceChildren, setHidden } from './dom';

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
  onBuy: (itemId: string) => void;
  onSell: (itemId: string) => void;
  onClose: () => void;
}

/** Thunks rather than constants so `t` runs after the locale resolves, each key in a literal `t('...')` the catalog test can find. */
const SERVICE_TITLE: Record<NPCService, () => string> = {
  kaempferMaster: () => t('Master of the Kämpfer'),
  heilerMaster: () => t('Master of the Heiler'),
  shopkeeper: () => t('Shopkeeper'),
};

const TEACHING_BLURB: Record<TeachingId, () => string> = {
  strike: () => t('Each rank adds to every hit you land.'),
  guard: () => t('Each rank makes nightmares miss you more often.'),
  'follow-through': () => t('Each rank shortens the pause between your swings.'),
  'balance-recovery': () => t('Each rank brings your balance back faster.'),
  toughening: () => t('Each rank raises your health by %@.', String(COMBAT.healthPerTougheningRank)),
  touch: () => t('Holding the Mondstein, click a dreamer to tend them. Your spirit mends them while you stay close.'),
  depth: () => t('Each rank mends more with every touch.'),
  'drawing-back': () => t('Holding the Mondstein, stay close to a fallen dreamer you tend to raise them.'),
  'spirit-deepening': () => t('Each rank raises your spirit by %@.', String(COMBAT.spiritPerDeepeningRank)),
};

function roleName(role: Role): string {
  return t(roleLabelKey(role));
}

/** What a task asks for, with the condition it is held under. */
function taskText(spec: TaskSpec): string[] {
  switch (spec.kind) {
    case 'driveOff':
      return [
        spec.count === 1 ? t('Drive off a nightmare.') : t('Drive off %@ nightmares.', String(spec.count)),
        ...(spec.withoutFalling === true ? [t('Falling starts the count over.')] : []),
      ];
    case 'reach':
      return [t('Walk to the %@ and come back.', spec.sector), ...(spec.withoutStriking === true ? [t('You cannot strike while you hold this trial.')] : [])];
    case 'mend':
      return [t('Mend %@ health on other dreamers.', String(spec.amount))];
  }
}

/** How far a held task has come. A task this client cannot read has no line. */
export function taskProgressText(task: TaskMessage): string | undefined {
  const spec = taskSpecOf(task);
  return spec === undefined ? undefined : t('%1$@ of %2$@', String(Math.floor(task.progress)), String(taskGoal(spec)));
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
  }

  render(npc: ClientEntity | undefined, lucidity: LucidityMessage, inventory: readonly InventoryRowMessage[], tradeLocked: boolean): void {
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
    inventory: readonly InventoryRowMessage[],
    tradeLocked: boolean,
  ): { reads: readonly unknown[]; purse?: number; build: () => HTMLElement[] } {
    switch (service) {
      case 'kaempferMaster':
      case 'heilerMaster':
        return { reads: [lucidity], build: () => this.master(npc, masterRole(service), lucidity) };
      case 'shopkeeper':
        return { reads: [inventory, tradeLocked], purse: purseCoins(inventory), build: () => this.shop(npc, inventory, tradeLocked) };
    }
  }

  /** Every ware the dreamer does not carry, to buy, and those they carry, to sell back. Every button is disabled while a trade holds the lock. */
  private shop(npc: ClientEntity, inventory: readonly InventoryRowMessage[], tradeLocked: boolean): HTMLElement[] {
    const forSale = WARES.filter((ware) => !canSell(inventory, ware)).map((ware) => this.wareRow(ware, inventory, tradeLocked));
    const yours = WARES.filter((ware) => canSell(inventory, ware)).map((ware) => this.wareRow(ware, inventory, tradeLocked));
    return [
      paragraph(t('%@ deals in weapons. He buys back what he sells for half its price.', npc.name)),
      ...(forSale.length === 0 ? [] : [element('h2', { className: 'service-heading', text: t('For sale') }), ...forSale]),
      element('h2', { className: 'service-heading', text: t('Sell') }),
      ...(yours.length === 0 ? [paragraph(t('You carry nothing %@ buys.', npc.name), 'form-note')] : yours),
    ];
  }

  private wareRow(ware: Ware, inventory: readonly InventoryRowMessage[], tradeLocked: boolean): HTMLElement {
    const { labelKey, weapon } = ITEMS[ware];
    const price = SHOP.prices[ware];
    const short = price - purseCoins(inventory);
    let notes: HTMLElement[] = [];
    let action: HTMLButtonElement;
    if (canSell(inventory, ware)) {
      action = button(t('Sell for %@c', String(buyBackPrice(ware))), () => this.callbacks.onSell(ware));
      action.disabled = tradeLocked;
    } else {
      action = button(t('Buy for %@c', String(price)), () => this.callbacks.onBuy(ware));
      action.disabled = tradeLocked || !canBuy(inventory, ware);
      if (short > 0) notes = [paragraph(t('You need %@c more.', String(short)), 'form-note')];
    }
    return element('div', {
      className: 'ware-row',
      attributes: { 'data-ware': ware },
      children: [
        element('div', {
          className: 'ware-head',
          children: [
            element('strong', { text: t(labelKey) }),
            ...(itemInHand(inventory) === ware ? [element('span', { className: 'ware-tag', text: t('In hand') })] : []),
          ],
        }),
        paragraph(t('%1$@ damage, %2$@ balance a swing', String(weapon.damage), String(weapon.balanceCost)), 'service-text'),
        ...notes,
        element('div', { className: 'ware-action', children: [action] }),
      ],
    });
  }

  private master(npc: ClientEntity, role: Role, lucidity: LucidityMessage): HTMLElement[] {
    if (lucidity.role === undefined) return this.trial(npc, role, lucidity.task);
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

  /** A dreamer with no role yet: the offer, the trial under way, or the choice it earned. */
  private trial(npc: ClientEntity, role: Role, task: TaskMessage | undefined): HTMLElement[] {
    if (task === undefined) {
      return [
        paragraph(
          t(
            '%1$@ takes on those who pass a trial. Passing it commits you to nothing: you choose afterwards whether to become a %2$@.',
            npc.name,
            roleName(role),
          ),
        ),
        ...taskText(TRIALS[role]).map((line) => paragraph(line, 'form-note')),
        button(t('Ask for the trial'), () => this.callbacks.onAskTask()),
      ];
    }
    if (task.role !== role) {
      return [paragraph(t("You hold another master's trial. One trial at a time.")), button(t('Give up that trial'), () => this.callbacks.onAbandonTask())];
    }
    if (!taskIsDone(task)) {
      return [
        element('h2', { className: 'service-heading', text: t('Your trial') }),
        ...this.taskLines(task),
        button(t('Give up the trial'), () => this.callbacks.onAbandonTask()),
      ];
    }
    return [
      element('h2', { className: 'service-heading', text: t('Become a %@?', roleName(role)) }),
      paragraph(
        t('You passed the trial. Accepting makes you a %@ for good. It cannot be undone, and the other master will not teach you afterwards.', roleName(role)),
      ),
      element('div', {
        className: 'form-actions',
        children: [button(t('Not yet'), () => this.callbacks.onClose()), button(t('Become a %@', roleName(role)), () => this.callbacks.onCompleteTask())],
      }),
    ];
  }

  private taskLines(task: TaskMessage): HTMLElement[] {
    const spec = taskSpecOf(task);
    const progress = taskProgressText(task);
    if (spec === undefined || progress === undefined) return [];
    const [what, ...conditions] = taskText(spec);
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
        ...taskText(teaching(id).gate!).map((line) => paragraph(line, 'form-note')),
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
    return { notes: this.taskLines(task), action: button(t('Give up the task'), () => this.callbacks.onAbandonTask()) };
  }
}
