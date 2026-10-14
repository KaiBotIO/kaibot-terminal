import { useEffect, useReducer, useRef } from "react";

interface CachedImageData {
  url: string;
  cityName: string;
  timestamp: number;
}

interface AuthBackgroundProps {
  unsplashAccessKey?: string;
  unsplashCollection?: string;
  cacheKey?: string;
  cacheMinutes?: number;
  fallbackImage?: string;
}

const DEFAULT_ACCESS_KEY = "oLQTwFD_1Fa9uwHCupZ8B5439y6obULqEmRcgoFZUC0";

interface BackgroundState {
  imageData: CachedImageData | null;
  isLoading: boolean;
}

type BackgroundAction =
  | { type: "loadStart" }
  | { type: "resolved"; data: CachedImageData }
  | { type: "settled" };

function backgroundReducer(
  state: BackgroundState,
  action: BackgroundAction,
): BackgroundState {
  switch (action.type) {
    case "loadStart":
      return { ...state, isLoading: true };
    case "resolved":
      return { ...state, imageData: action.data };
    case "settled":
      return { ...state, isLoading: false };
    default:
      return state;
  }
}

export function AuthBackground({
  unsplashAccessKey = DEFAULT_ACCESS_KEY,
  unsplashCollection = "917009",
  cacheKey = "cachedCityImage",
  cacheMinutes = 5,
  fallbackImage,
}: AuthBackgroundProps) {
  const [state, dispatch] = useReducer(backgroundReducer, {
    imageData: null,
    isLoading: true,
  });
  const { imageData, isLoading } = state;
  const hasStartedLoading = useRef(false);

  useEffect(() => {
    const cacheDuration = cacheMinutes * 60 * 1000;

    const getCached = (): CachedImageData | null => {
      try {
        const raw = localStorage.getItem(cacheKey);
        if (!raw) return null;
        const parsed: CachedImageData = JSON.parse(raw);
        if (Date.now() - parsed.timestamp < cacheDuration) return parsed;
      } catch {}
      return null;
    };

    const setCached = (data: CachedImageData) => {
      try {
        localStorage.setItem(cacheKey, JSON.stringify(data));
      } catch {}
    };

    const fetchImage = async () => {
      if (hasStartedLoading.current) return;
      hasStartedLoading.current = true;

      dispatch({ type: "loadStart" });
      const cached = getCached();
      if (cached) {
        dispatch({ type: "resolved", data: cached });
        dispatch({ type: "settled" });
        return;
      }

      try {
        const collection = encodeURIComponent(unsplashCollection);
        const response = await fetch(
          `https://api.unsplash.com/photos/random?collections=${collection}&orientation=portrait&content_filter=high&client_id=${unsplashAccessKey}`,
        );
        if (!response.ok) throw new Error("Failed to fetch image");
        const data = await response.json();

        let cityName = "Unknown City";
        if (data.location?.city) cityName = data.location.city;
        else if (data.location?.name)
          cityName = data.location.name.split(",")[0].trim();

        const newData: CachedImageData = {
          url: data.urls.regular,
          cityName,
          timestamp: Date.now(),
        };
        dispatch({ type: "resolved", data: newData });
        setCached(newData);
      } catch {
        if (fallbackImage) {
          dispatch({
            type: "resolved",
            data: {
              url: fallbackImage,
              cityName: "Unknown City",
              timestamp: Date.now(),
            },
          });
        }
      } finally {
        dispatch({ type: "settled" });
      }
    };
    fetchImage();
  }, [unsplashAccessKey, unsplashCollection, cacheKey, cacheMinutes, fallbackImage]);

  if (!imageData) return null;

  const hasCity = imageData.cityName !== "Unknown City";

  return (
    <div className="relative w-full h-full">
      {isLoading && <div className="absolute inset-0 bg-muted animate-pulse" />}
      <img
        src={imageData.url}
        alt={hasCity ? `${imageData.cityName} skyline` : "City skyline"}
        className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-500 ${
          isLoading ? "opacity-0" : "opacity-100"
        }`}
        onLoad={() => dispatch({ type: "settled" })}
      />
      {hasCity && (
        <div className="absolute bottom-4 right-4 border border-border bg-[hsl(var(--surface-container-low))]/80 backdrop-blur-sm text-white px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest">
          {imageData.cityName}
        </div>
      )}
    </div>
  );
}
