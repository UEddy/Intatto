import { useQuery } from "@tanstack/react-query";
import { useServices } from "../app/services";
import { ftMetadata } from "../contract/views";
import { formatUnits } from "../near/units";

/** A token's metadata, read once per session: decimals come from the chain, never from config. */
export function useFtMetadata(tokenId: string | null | undefined) {
  const { chain, config } = useServices();
  return useQuery({
    queryKey: [config.networkId, "ft_metadata", tokenId],
    queryFn: () => ftMetadata(chain, tokenId!),
    enabled: !!tokenId,
    staleTime: Infinity,
    retry: 1,
  });
}

/** An amount of `tokenId` in its smallest units. Until metadata loads, shows the raw integer. */
export function TokenAmount({ tokenId, raw, maxFraction = 4 }: { tokenId: string; raw: string; maxFraction?: number }) {
  const meta = useFtMetadata(tokenId);
  if (!meta.data) {
    return (
      <span className="mono" title={`${raw} (smallest units of ${tokenId})`}>
        {raw} <span className="unit">{tokenId}</span>
      </span>
    );
  }
  const { decimals, symbol } = meta.data.value;
  return (
    <span className="mono" title={`${raw} raw · ${decimals} decimals (ft_metadata of ${tokenId}, block ${meta.data.source.blockHeight})`}>
      {formatUnits(BigInt(raw), decimals, { maxFraction })} <span className="unit">{symbol}</span>
    </span>
  );
}
