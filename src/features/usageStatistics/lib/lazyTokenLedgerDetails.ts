export const createLazyTokenLedgerDetailLookup = <TDetail>(
  loadDetails: () => Promise<ReadonlyMap<string, TDetail>>
) => {
  let detailsPromise: Promise<ReadonlyMap<string, TDetail>> | null = null;

  return async (requestId: string): Promise<TDetail | undefined> => {
    detailsPromise ??= loadDetails();
    return (await detailsPromise).get(requestId);
  };
};
