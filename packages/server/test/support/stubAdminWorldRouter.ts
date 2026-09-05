import type { SomnioMessage } from '@somnio/protocol';
import type { AdminWorldRouter } from '../../src/world/worldRouter.ts';

/** Records every broadcast and lets a test pin the player count and kick outcome. */
export class StubAdminWorldRouter implements AdminWorldRouter {
  playerCount = 0;
  kickOutcome = false;
  readonly broadcasts: SomnioMessage[] = [];

  loggedInPlayerCount(): number {
    return this.playerCount;
  }

  kickByCharacterName(): boolean {
    return this.kickOutcome;
  }

  broadcastToAllConnections(message: SomnioMessage): void {
    this.broadcasts.push(message);
  }
}
