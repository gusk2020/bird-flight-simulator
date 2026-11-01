import type { Surface } from "./perches";

/** H2 足場の使い方の区別: 立って止まれるだけ(stand)か、その上を歩ける(walk)か。
 *  歩く距離は、立った点から長手方向の端の手前で止まるまで。計測(test/h2walk.ts): 長さ L の足場で歩ける距離は約 L - 0.94 m。
 *  十分な歩行距離がない細い足場(電線の短い区間・小さな枝・杭・看板・ベンチなど)は、その場で立てても「歩ける」とは数えない。 */
export const PERCH_WALK = { minWalkM: 2.0, endMarginM: 0.94 };
export type PerchUse = "walk" | "stand";
export interface PerchClass { use: PerchUse; length: number; width: number; walkM: number }
export function perchClass(s: Pick<Surface, "minX" | "maxX" | "minZ" | "maxZ">): PerchClass {
  const w = s.maxX - s.minX, d = s.maxZ - s.minZ, length = Math.max(w, d), width = Math.min(w, d), walkM = Math.max(0, length - PERCH_WALK.endMarginM);
  return { use: walkM >= PERCH_WALK.minWalkM ? "walk" : "stand", length, width, walkM };
}
