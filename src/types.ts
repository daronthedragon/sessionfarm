export interface AuthCheck {
  /** URL to load when testing whether this profile is still logged in. */
  url: string;
  /** Profile counts as authenticated when this selector is present. */
  okSelector?: string;
  /** Profile counts as authenticated when this text appears in the body. */
  okText?: string;
  /** Profile counts as EXPIRED when this selector is present (e.g. a login form). */
  failSelector?: string;
}

export interface ProfileConfig {
  name: string;
  createdAt: string;
  /** Freeform label, e.g. "client-b instagram". */
  notes?: string;
  proxy?: { server: string; username?: string; password?: string };
  userAgent?: string;
  viewport?: { width: number; height: number };
  locale?: string;
  timezoneId?: string;
  authCheck?: AuthCheck;
}

export interface Lease {
  id: string;
  profile: string;
  acquiredAt: number;
  expiresAt: number;
  holder?: string;
}

export type HealthState = 'authenticated' | 'expired' | 'unknown' | 'error';

export interface HealthResult {
  state: HealthState;
  checkedAt: string;
  detail?: string;
}

export interface ProfileStatus {
  name: string;
  running: boolean;
  /** Uptime of the browser process in ms; sessions cookies die when this resets. */
  warmForMs: number | null;
  lease: Lease | null;
  lastUsed: string | null;
  health: HealthResult | null;
  notes?: string;
}
