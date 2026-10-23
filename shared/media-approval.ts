/** Cost gate only; normal action authorization still runs. Never infer zero cost from locality. */
export function mediaNeedsBudgetApproval(
  estimatedUsd: number | null | undefined,
  limit: number | null | undefined,
) {
  if (estimatedUsd == null || !Number.isFinite(estimatedUsd) || estimatedUsd < 0) return true;
  if (estimatedUsd === 0) return false;
  return limit == null || !Number.isFinite(limit) || limit < 0 || estimatedUsd > limit;
}
export function mediaReviewContext(
  service: { id: string; kind: string; baseUrl: string; estimatedUsd?: number | null },
  limit: number | null | undefined,
) {
  const url = new URL(service.baseUrl);
  return {
    source: 'host-configured-service',
    serviceId: service.id,
    kind: service.kind,
    endpointOrigin: url.origin,
    loopback: ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname),
    estimatedUsd: service.estimatedUsd ?? null,
    configuredLimitUsd: limit ?? null,
    estimateIsGuarantee: false,
    localityIsAuthorization: false,
  };
}
