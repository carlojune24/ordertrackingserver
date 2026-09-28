export interface JwtUserPayload {
  sub: string;
  email: string;
  roleId: string;
  /** Display-only — never trust this for authorization decisions. authorize() always re-resolves live from the DB. */
  roleName: string;
  name: string;
  /** Display-only, same freshness caveat as roleName — assertStationAllowed (scan.service.ts)
   * always re-resolves this live from the DB before honoring any scan/reject action, so a
   * stale value here (e.g. reassigned mid-session) can't grant scanning at the wrong station,
   * it can only make the UI briefly show the old station until the next login/refresh. */
  assignedStationId: string | null;
  assignedStationName: string | null;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: JwtUserPayload;
    user: JwtUserPayload;
  }
}
