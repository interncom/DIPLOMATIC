// import { useContext, useCallback } from "react";
// import { EntitiesQuery, IEntity } from "../entdb/entdb";
// import useStateWatcher from "./useStateWatcher";

// export function useEntities<T>(
//   { type, pid, updatedAt }: EntitiesQuery,
// ): IEntity<T>[] | undefined {
//   const { stateManager, entityDB } = useContext(AppContext);
//   const getter = useCallback(() => {
//     return entityDB.getEntities<T>({ type, pid, updatedAt });
//   }, [entityDB, type, pid, updatedAt]);
//   return useStateWatcher(stateManager, type, getter);
// }

// export function useEntitiesCount({ type }: { type: string }): number | undefined {
//   const { stateManager, entityDB } = useContext(AppContext);
//   const getter = useCallback(() => {
//     return entityDB.countEntities({ type });
//   }, [entityDB, type]);
//   return useStateWatcher(stateManager, type, getter);
// }
