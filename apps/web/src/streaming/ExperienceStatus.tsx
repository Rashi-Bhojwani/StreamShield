import { useQuery } from "@tanstack/react-query";
import { experienceSchema } from "@streamshield/shared";
import { useAuth } from "../platform/auth-context";
import { platformRequest, RequestError } from "../platform/request";
import { config } from "../config";
import { Icon } from "../ui/Icon";

export function ExperienceStatus() {
  const { user } = useAuth();
  const q = useQuery({
    queryKey: ["experience-impact", user?.id],
    enabled: !!user && config.VITE_DYNAMIC_MODE,
    queryFn: async () => {
      const value = await platformRequest<{ enabled: boolean }>(
        "/monitoring/experience",
      ).catch((error) => {
        if (error instanceof RequestError && error.status === 404)
          return { enabled: false };
        throw error;
      });
      return value.enabled ? experienceSchema.parse(value) : null;
    },
    refetchInterval: 3000,
    retry: false,
  });
  if (
    !user ||
    !config.VITE_DYNAMIC_MODE ||
    q.isPending ||
    (!q.isError && !q.data)
  )
    return null;
  const status = q.isError ? "unavailable" : q.data?.state || "unavailable";
  const recovering = status === "recovering";
  const recommendations = q.isError ? undefined : q.data?.recommendations;
  const api = q.isError ? undefined : q.data?.api;
  return (
    <section
      className={
        "experience-status experience-" +
        status +
        (api ? " experience-with-api" : "")
      }
      aria-label="Live service impact"
      data-testid="live-service-impact"
      data-state={status}
    >
      <div className="experience-summary" role="status">
        {recovering ? (
          <span className="recovery-spinner" aria-hidden="true" />
        ) : (
          <Icon
            name={
              status === "healthy" || status === "recovered"
                ? "shield"
                : "pulse"
            }
          />
        )}
        <div>
          <strong>
            {recovering
              ? "Recovery in progress"
              : status === "human_required"
                ? "Human action required"
                : status === "recovered"
                  ? "Back in rhythm"
                  : status === "healthy"
                    ? "Live service updates"
                    : status === "failed"
                      ? "Recovery needs attention"
                      : "Connection status unavailable"}
          </strong>
          <p>
            {q.isError
              ? "Reconnecting to service status. Playback is monitored separately."
              : q.data?.message}
          </p>
        </div>
      </div>
      {api && (
        <div
          className="experience-api"
          data-testid="api-continuity"
          data-primary={api.primary}
          data-served-by={api.servedBy || "unknown"}
        >
          <strong>Live API connection</strong>
          <p>
            API-1: <span>{api.primary}</span> · API-2: <span>{api.backup}</span>
          </p>
          {api.servedBy && (
            <p>
              This response was served by{" "}
              <strong>{api.servedBy.toUpperCase()}</strong>.
            </p>
          )}
          {api.primary !== "healthy" && api.backup === "healthy" && (
            <p role="status">
              <span className="recovery-spinner" aria-hidden="true" />
              The backup API is available while API-1 is checked. Video delivery
              uses its own connection.
            </p>
          )}
        </div>
      )}
      <div
        className="experience-recommendations"
        data-testid="recommendation-status"
        data-state={
          recommendations?.available === true
            ? "available"
            : recommendations?.available === false
              ? "reconnecting"
              : "unavailable"
        }
      >
        <span className="eyebrow">
          Discover next <small>Demo dependency</small>
        </span>
        {recommendations?.available === true ? (
          <a href="/live" target="_blank" rel="noopener noreferrer">
            <Icon name="spark" />{" "}
            {recommendations.items[0] || "Explore live channels"}
            <Icon name="arrow" />
          </a>
        ) : (
          <p role="status">
            {recommendations?.available === false && (
              <span className="recovery-spinner" aria-hidden="true" />
            )}
            {recommendations?.available === false
              ? "Reconnecting recommendations…"
              : "Recommendations unavailable"}
          </p>
        )}
      </div>
    </section>
  );
}
