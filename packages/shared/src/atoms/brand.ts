import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

export type BrandVariant = "auric" | "kaibot";

// Must match TRADITIONAL_MARKETS_ROLE in @kaibot/types (avoid a cross-package
// import in this leaf atoms module).
const TRADITIONAL_MARKETS_ROLE = "traditional-markets";

/**
 * Dev-only override. With no override set ("auto"), the brand follows the
 * variant: internal users -> kaibot (blue), external users -> auric (gold).
 * Set "auric"/"kaibot" in localStorage to force a variant while developing.
 */
export const brandVariantAtom = atomWithStorage<BrandVariant | "auto">(
  "brandVariant",
  "auto",
);

export const userGroupsAtom = atom<string[]>([]);
export const userRolesAtom = atom<string[]>([]);

export const isClassicMemberAtom = atom((get) =>
  get(userGroupsAtom).includes("classic"),
);

/**
 * Internal = member of the 'classic' group OR carrying the traditional-markets
 * role. Internal -> blue brand + all markets. Everyone else is external (gold,
 * crypto only). Mirrors isInternalUser() on the server (@kaibot/trpc access.ts).
 */
export const isInternalUserAtom = atom(
  (get) =>
    get(isClassicMemberAtom) ||
    get(userRolesAtom).includes(TRADITIONAL_MARKETS_ROLE),
);

export const effectiveBrandVariantAtom = atom<BrandVariant>((get) => {
  const override = get(brandVariantAtom);
  if (override !== "auto") return override;
  return get(isInternalUserAtom) ? "kaibot" : "auric";
});
