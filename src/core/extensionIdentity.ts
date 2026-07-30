/**
 * Single source of truth for the published extension identity.
 *
 * The id had been hardcoded in five places and three of them carried the stale
 * `vscodesync.vscodesync` value, which never resolved: "Open Settings" opened an
 * empty filtered view and the integration suite could not find the extension at
 * all. `extensionIdentity.test.ts` pins these constants to `package.json`, so a
 * rename of publisher or name fails the test instead of silently breaking the UI.
 */

/** `publisher.name` exactly as published to the marketplaces. */
export const EXTENSION_ID = "borodatych.vscodesyncfiles";

/** Query that filters the VS Code Settings UI down to this extension. */
export const EXTENSION_SETTINGS_QUERY = `@ext:${EXTENSION_ID}`;

/** Configuration section owning every `vscodesync.*` setting. */
export const CONFIG_SECTION = "vscodesync";
