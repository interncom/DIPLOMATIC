import { EntityDB, DiplomaticClient, idbStore } from "@interncom/diplomatic";

export const stateManager = EntityDB.stateManager;
export const client = new DiplomaticClient({ store: idbStore, stateManager });
