
export function useEntities<T>(
  { type, gid, pid, updatedBetween }: EntitiesQuery,
): IEntity<T>[] | undefined {
  const { stateManager, entityDB } = useContext(AppContext);
  const getter = useCallback(() => {
    return entityDB.getEntities<T>({ type, gid, pid, updatedBetween });
  }, [entityDB, type, gid, pid, updatedBetween]);
  return useStateWatcher(stateManager, type, getter);
}

export function useEntitiesCount({ type }: { type: string }): number | undefined {
  const { stateManager, entityDB } = useContext(AppContext);
  const getter = useCallback(() => {
    return entityDB.countEntities({ type });
  }, [entityDB, type]);
  return useStateWatcher(stateManager, type, getter);
}
