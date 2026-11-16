/*
 * Grab-Or-Not Notion Presets
 *
 * A Preset now owns its Notion workspace context.
 *
 * The old mirrored Notion keys remain temporarily so
 * the existing popup/background code keeps working
 * while the Notion save path is migrated.
 */

(() => {
  "use strict";

  const PRESETS_KEY =
    "notionPresets";

  const ACTIVE_KEY =
    "notionActivePresetId";

  const STORE_VERSION_KEY =
    "notionPresetStoreVersion";

  const STORE_VERSION = 2;

  const SYNC_META_KEY =
    "clipnestNotionSyncMetaV1";

  const SYNC_CHUNK_PREFIX =
    "clipnestNotionSyncChunkV1_";

  const SYNC_PAYLOAD_VERSION = 1;

  const SYNC_ITEM_TARGET_BYTES = 7600;

  const LOCAL_SYNC_META_KEY =
    "clipnestNotionLocalSyncMetaV1";

  const SYNC_WARNING_KEY = "clipnestNotionSyncWarningV1";

  async function setSyncWarning(message) {
    try {
      if (message) {
        await chrome.storage.local.set({ [SYNC_WARNING_KEY]: message });
      } else {
        await chrome.storage.local.remove(SYNC_WARNING_KEY);
      }
    } catch (error) {
      console.warn("Notion sync warning storage failed:", error);
    }
  }

  let syncHydrationPromise =
    null;

  let syncListenerInstalled =
    false;

  let syncWriteDepth = 0;

  function createId() {
    if (
      globalThis.crypto
        ?.randomUUID
    ) {
      return crypto.randomUUID();
    }

    return (
      `notion-${Date.now()}-` +
      Math.random()
        .toString(16)
        .slice(2)
    );
  }

  function cleanText(
    value
  ) {
    return String(
      value || ""
    ).trim();
  }

  function cleanStringArray(
    value
  ) {
    if (!Array.isArray(value)) {
      return [];
    }

    return [
      ...new Set(
        value
          .map(cleanText)
          .filter(Boolean)
      )
    ];
  }

  function normalizePresetField(
    field,
    fallbackOrder = 0
  ) {
    if (
      !field ||
      typeof field !==
        "object"
    ) {
      return null;
    }

    const propertyId =
      cleanText(
        field.propertyId
      );

    if (!propertyId) {
      return null;
    }

    const propertyType =
      cleanText(
        field.propertyType
      );

    const propertyName =
      cleanText(
        field.propertyName ||
        field.label
      );

    const label =
      cleanText(
        field.label ||
        propertyName
      ) ||
      "Field";

    const rawOrder =
      Number(
        field.order
      );

    const order =
      Number.isFinite(
        rawOrder
      )
        ? rawOrder
        : fallbackOrder;

    let defaultValue;

    if (
      Object.prototype
        .hasOwnProperty.call(
          field,
          "defaultValue"
        )
    ) {
      defaultValue =
        Array.isArray(
          field.defaultValue
        )
          ? [
              ...field.defaultValue
            ]
          : field.defaultValue;
    } else {
      defaultValue =
        propertyType ===
          "multi_select"
          ? []
          : "";
    }

    /*
     * CLIP FORM VISIBILITY NORMALIZATION - 2.0.62
     *
     * showInClipForm is the durable preference.
     * visible is only the effective compatibility value used
     * by the current popup renderer and popupProperties list.
     */
    const source =
      cleanText(
        field.source
      ) ||
      "manual";

    const showInClipForm =
      typeof field.showInClipForm ===
        "boolean"
        ? field.showInClipForm
        : source ===
            "page_url"
          ? false
          : source ===
              "page_author"
            ? field.visible !==
                false
            : true;

    const visible =
      source ===
        "fixed"
        ? false
        : (
            source ===
              "page_url" ||
            source ===
              "page_author"
          )
          ? showInClipForm
          : field.visible !==
              false;

    return {
      ...field,

      propertyId,

      propertyName,

      propertyType,

      label,

      order,

      showInClipForm,

      visible,

      source,

      required:
        field.required ===
          true,

      defaultValue
    };
  }

  function deriveLegacyPresetFields(
    raw,
    {
      titleProperty = "Name",
      urlProperty = "",
      tagsProperty = ""
    } = {}
  ) {
    const propertyIds =
      raw?.propertyIds &&
      typeof raw.propertyIds ===
        "object"
        ? raw.propertyIds
        : {};

    const fields =
      [];

    const titleId =
      cleanText(
        propertyIds.title
      );

    if (titleId) {
      fields.push({
        propertyId:
          titleId,

        propertyName:
          cleanText(
            titleProperty
          ) ||
          "Name",

        propertyType:
          "title",

        label:
          "Title",

        order:
          fields.length,

        visible:
          true,

        source:
          "page_title",

        required:
          true,

        defaultValue:
          ""
      });
    }

    const tagsId =
      cleanText(
        propertyIds.tags
      );

    if (tagsId) {
      fields.push({
        propertyId:
          tagsId,

        propertyName:
          cleanText(
            tagsProperty
          ) ||
          "Tags",

        propertyType:
          "multi_select",

        label:
          "Tags",

        order:
          fields.length,

        visible:
          true,

        source:
          "manual",

        required:
          false,

        defaultValue:
          []
      });
    }

    const urlId =
      cleanText(
        propertyIds.url
      );

    if (urlId) {
      fields.push({
        propertyId:
          urlId,

        propertyName:
          cleanText(
            urlProperty
          ) ||
          "URL",

        propertyType:
          "url",

        label:
          "URL",

        order:
          fields.length,

        visible:
          false,

        source:
          "page_url",

        required:
          false,

        defaultValue:
          ""
      });
    }

    return fields;
  }

  function normalizePresetFields(
    raw,
    names = {}
  ) {
    const fieldsConfigured =
      raw?.fieldsConfigured ===
        true;

    /*
     * During migration, old property mappings remain
     * authoritative. This also keeps the existing
     * Settings editor safe while the new preset editor
     * is still being built.
     */
    const source =
      fieldsConfigured &&
      Array.isArray(
        raw?.fields
      )
        ? raw.fields
        : deriveLegacyPresetFields(
            raw,
            names
          );

    return source
      .map(
        (
          field,
          index
        ) =>
          normalizePresetField(
            field,
            index
          )
      )
      .filter(Boolean)
      .sort(
        (a, b) =>
          a.order -
          b.order
      )
      .map(
        (
          field,
          index
        ) => ({
          ...field,

          order:
            index
        })
      );
  }

  function normalizePreset(
    raw = {},
    index = 0
  ) {
    const mappings =
      raw.propertyMappings &&
      typeof raw.propertyMappings ===
        "object"
        ? raw.propertyMappings
        : {};

    const defaults =
      raw.propertyDefaults &&
      typeof raw.propertyDefaults ===
        "object" &&
      !Array.isArray(
        raw.propertyDefaults
      )
        ? raw.propertyDefaults
        : {};

    const titleProperty =
      cleanText(
        raw.titleProperty ??
        mappings.title
      ) ||
      "Name";

    const urlProperty =
      cleanText(
        raw.urlProperty ??
        mappings.url
      );

    const tagsProperty =
      cleanText(
        raw.tagsProperty ??
        mappings.tags
      );

    const fieldsConfigured =
      raw.fieldsConfigured ===
        true;

    const fields =
      normalizePresetFields(
        raw,
        {
          titleProperty,
          urlProperty,
          tagsProperty
        }
      );

    return {
      id:
        cleanText(
          raw.id
        ) ||
        createId(),

      name:
        cleanText(
          raw.name
        ) ||
        `Notion preset ${index + 1}`,

      presetIcon:
        cleanText(
          raw.presetIcon
        ),

      workspaceId:
        cleanText(
          raw.workspaceId
        ),

      workspaceName:
        cleanText(
          raw.workspaceName
        ),

      workspaceUserId:
        cleanText(
          raw.workspaceUserId
        ),

      workspaceSpaceViewIds:
        cleanStringArray(
          raw.workspaceSpaceViewIds
        ),

      dataSourceId:
        cleanText(
          raw.dataSourceId
        ),

      destinationType:
        cleanText(
          raw.destinationType
        ),

      destinationId:
        cleanText(
          raw.destinationId
        ),

      destinationName:
        cleanText(
          raw.destinationName
        ),

      destinationIcon:
        raw.destinationIcon ??
        "",

      destinationParents:
        Array.isArray(
          raw.destinationParents
        )
          ? raw.destinationParents
          : [],

      destinationParentId:
        cleanText(
          raw.destinationParentId
        ),

      destinationParentTable:
        cleanText(
          raw.destinationParentTable
        ),

      fieldsConfigured,

      fields,

      propertyIds: {
        title:
          cleanText(
            raw.propertyIds
              ?.title
          ),

        url:
          cleanText(
            raw.propertyIds
              ?.url
          ),

        tags:
          cleanText(
            raw.propertyIds
              ?.tags
          )
      },

      titleProperty,

      urlProperty,

      tagsProperty,

      propertyMappings: {
        ...mappings,

        title:
          titleProperty,

        url:
          urlProperty,

        tags:
          tagsProperty
      },

      propertyDefaults: {
        ...defaults
      },

      popupProperties:
        cleanStringArray(
          raw.popupProperties
        )
    };
  }

  function normalizePresets(
    value
  ) {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.map(
      normalizePreset
    );
  }

  async function mirrorPreset(
    preset
  ) {
    if (!preset) {
      await chrome.storage.local.set({
        notionDataSourceId:
          "",

        notionTitleProperty:
          "Name",

        notionUrlProperty:
          "",

        notionWorkspaceId:
          "",

        notionWorkspaceName:
          "",

        notionWorkspaceUserId:
          "",

        notionWorkspaceSpaceViewIds:
          []
      });

      return;
    }

    const normalized =
      normalizePreset(
        preset
      );

    await chrome.storage.local.set({
      notionDataSourceId:
        normalized.dataSourceId,

      notionTitleProperty:
        normalized.titleProperty,

      notionUrlProperty:
        normalized.urlProperty,

      notionWorkspaceId:
        normalized.workspaceId,

      notionWorkspaceName:
        normalized.workspaceName,

      notionWorkspaceUserId:
        normalized.workspaceUserId,

      notionWorkspaceSpaceViewIds:
        normalized
          .workspaceSpaceViewIds
    });
  }

  function buildSyncPayload(
    presets,
    activePresetId,
    updatedAt = Date.now(),
    isReset = false
  ) {
    const timestamp =
      Math.max(
        0,
        Number(
          updatedAt
        ) ||
        0
      ) ||
      Date.now();

    return {
      version:
        SYNC_PAYLOAD_VERSION,

      updatedAt:
        timestamp,

      reset: isReset === true,

      presets:
        normalizePresets(
          presets
        ),

      activePresetId:
        cleanText(
          activePresetId
        )
    };
  }

  function splitSyncPayload(
    payload
  ) {
    const serialized =
      JSON.stringify(
        payload
      );

    const characters =
      Array.from(
        serialized
      );

    const encoder =
      new TextEncoder();

    const chunks =
      [];

    let start =
      0;

    while (
      start <
      characters.length
    ) {
      const key =
        SYNC_CHUNK_PREFIX +
        chunks.length;

      let low =
        start + 1;

      let high =
        characters.length;

      let best =
        start;

      while (
        low <= high
      ) {
        const middle =
          Math.floor(
            (
              low +
              high
            ) /
            2
          );

        const candidate =
          characters
            .slice(
              start,
              middle
            )
            .join("");

        const bytes =
          encoder.encode(
            key
          ).byteLength +
          encoder.encode(
            JSON.stringify(
              candidate
            )
          ).byteLength;

        if (
          bytes <=
          SYNC_ITEM_TARGET_BYTES
        ) {
          best =
            middle;

          low =
            middle + 1;
        } else {
          high =
            middle - 1;
        }
      }

      if (
        best === start
      ) {
        throw new Error(
          "Grab-Or-Not could not create a safe Notion sync chunk."
        );
      }

      chunks.push(
        characters
          .slice(
            start,
            best
          )
          .join("")
      );

      start =
        best;
    }

    return chunks;
  }

  async function snapshotHash(serialized) {
    const bytes = new TextEncoder().encode(serialized);
    const digest = await crypto.subtle.digest("SHA-256", bytes);

    return Array.from(
      new Uint8Array(digest),
      byte => byte.toString(16).padStart(2, "0")
    ).join("");
  }

  async function readSyncPayload() {
    try {
      const metaResult =
        await chrome.storage.sync.get(
          SYNC_META_KEY
        );

      const meta =
        metaResult[
          SYNC_META_KEY
        ];

      if (!meta) {
        return {
          status:
            "missing",

          payload:
            null
        };
      }

      if (
        typeof meta !==
          "object" ||
        Number(
          meta.version
        ) !==
          SYNC_PAYLOAD_VERSION
      ) {
        console.warn(
          "Grab-Or-Not found invalid Notion sync metadata."
        );

        return {
          status:
            "error",

          payload:
            null
        };
      }

      const chunkCount =
        Number(
          meta.chunkCount
        );

      if (
        !Number.isInteger(
          chunkCount
        ) ||
        chunkCount < 1 ||
        chunkCount > 500
      ) {
        console.warn(
          "Grab-Or-Not found an invalid Notion sync chunk count."
        );

        return {
          status:
            "error",

          payload:
            null
        };
      }

      const generation =
        typeof meta.generation === "string"
          ? meta.generation
          : "";

      if (
        generation &&
        (!/^[A-Za-z0-9_-]{1,100}$/.test(generation) ||
         typeof meta.checksum !== "string")
      ) {
        return { status: "error", payload: null };
      }

      const chunkPrefix = generation
        ? SYNC_CHUNK_PREFIX + generation + "_"
        : SYNC_CHUNK_PREFIX;

      const keys = Array.from(
        { length: chunkCount },
        (_, index) => chunkPrefix + index
      );

      const stored =
        await chrome.storage.sync.get(
          keys
        );

      const incomplete =
        keys.some(
          (key) =>
            typeof stored[
              key
            ] !==
              "string"
        );

      if (incomplete) {
        console.warn(
          "Grab-Or-Not Notion sync is waiting for remaining chunks."
        );

        return {
          status:
            "error",

          payload:
            null
        };
      }

      const serialized =
        keys
          .map(
            (key) =>
              stored[
                key
              ]
          )
          .join("");

      if (!serialized) {
        return {
          status:
            "error",

          payload:
            null
        };
      }

      if (
        generation &&
        await snapshotHash(serialized) !== meta.checksum
      ) {
        console.warn("Grab-Or-Not detected an inconsistent sync snapshot.");
        return { status: "error", payload: null };
      }

      const parsed =
        JSON.parse(
          serialized
        );

      if (
        !parsed ||
        typeof parsed !==
          "object" ||
        Number(
          parsed.version
        ) !==
          SYNC_PAYLOAD_VERSION ||
        !Array.isArray(
          parsed.presets
        )
      ) {
        console.warn(
          "Grab-Or-Not found invalid synced Notion preset data."
        );

        return {
          status:
            "error",

          payload:
            null
        };
      }

      return {
        status:
          "ok",

        generation:
          generation,

        payload: {
          version:
            SYNC_PAYLOAD_VERSION,

          updatedAt:
            Number(
              parsed.updatedAt ||
              meta.updatedAt ||
              0
            ),

          reset: parsed.reset === true,

          presets:
            normalizePresets(
              parsed.presets
            ),

          activePresetId:
            cleanText(
              parsed.activePresetId
            )
        }
      };
    } catch (error) {
      console.warn(
        "Grab-Or-Not could not read synced Notion presets:",
        error
      );

      return {
        status:
          "error",

        payload:
          null
      };
    }
  }

  let syncWriteQueue = Promise.resolve();

  function writeSyncPayload(
    presets,
    activePresetId,
    updatedAt = Date.now(),
    isReset = false
  ) {
    const next = syncWriteQueue.then(() =>
      performSyncWritePayload(
        presets,
        activePresetId,
        updatedAt,
        isReset
      )
    );

    syncWriteQueue = next.then(
      () => undefined,
      () => undefined
    );

    return next;
  }

  async function performSyncWritePayload(
    presets,
    activePresetId,
    updatedAt = Date.now(),
    isReset = false
  ) {
    syncWriteDepth += 1;

    try {
      const payload = buildSyncPayload(
        presets,
        activePresetId,
        updatedAt,
        isReset
      );

      const serialized = JSON.stringify(payload);
      const chunks = splitSyncPayload(payload);
      const generation =
        Date.now().toString(36) + "-" + crypto.randomUUID();

      const prefix = SYNC_CHUNK_PREFIX + generation + "_";
      const previous = await chrome.storage.sync.get(null);
      const previousMeta = previous[SYNC_META_KEY];

      const staged = {};

      chunks.forEach((chunk, index) => {
        staged[prefix + index] = chunk;
      });

      // Publish immutable chunks before changing the active pointer.
      await chrome.storage.sync.set(staged);

      const verification = await chrome.storage.sync.get(
        Object.keys(staged)
      );

      for (const [key, value] of Object.entries(staged)) {
        if (verification[key] !== value) {
          throw new Error("Chrome Sync did not store the full snapshot.");
        }
      }

      const metadata = {
        version: SYNC_PAYLOAD_VERSION,
        updatedAt: payload.updatedAt,
        chunkCount: chunks.length,
        generation,
        checksum: await snapshotHash(serialized)
      };

      // This is the final commit pointer, never the first write.
      await chrome.storage.sync.set({
        [SYNC_META_KEY]: metadata
      });

      const committed = await chrome.storage.sync.get(SYNC_META_KEY);

      if (
        committed[SYNC_META_KEY]?.generation !== generation
      ) {
        throw new Error("Chrome Sync snapshot commit was superseded.");
      }

      // Retain the previous complete snapshot during propagation.
      // Remove only older generations already present before this write.
      const previousPrefix = previousMeta?.generation
        ? SYNC_CHUNK_PREFIX + previousMeta.generation + "_"
        : "";

      const oldKeys = Object.keys(previous).filter(key => {
        if (!key.startsWith(SYNC_CHUNK_PREFIX)) return false;

        if (previousPrefix) {
          return !key.startsWith(previousPrefix);
        }

        return !/^clipnestNotionSyncChunkV1_\\d+$/.test(key);
      });

      if (oldKeys.length) {
        try {
          const latest = await chrome.storage.sync.get(SYNC_META_KEY);

          if (latest[SYNC_META_KEY]?.generation === generation) {
            await chrome.storage.sync.remove(oldKeys);
          }
        } catch (cleanupError) {
          console.warn(
            "Could not clean up older Notion sync snapshots:",
            cleanupError
          );
        }
      }

      await setSyncWarning("");
      return true;
    } catch (error) {
      console.warn("Grab-Or-Not could not sync Notion presets:", error);

      await setSyncWarning(
        "Notion presets are saved locally, but Chrome Sync failed. " +
        "Export a settings backup and check synchronization."
      );

      return false;
    } finally {
      syncWriteDepth -= 1;
    }
  }

  async function writeLocalState(
    presets,
    activePresetId = "",
    updatedAt = 0
  ) {
    const normalized =
      normalizePresets(
        presets
      );

    let activeId =
      cleanText(
        activePresetId
      );

    if (
      !normalized.some(
        (preset) =>
          preset.id ===
          activeId
      )
    ) {
      activeId =
        normalized[0]
          ?.id ||
        "";
    }

    const activePreset =
      normalized.find(
        (preset) =>
          preset.id ===
          activeId
      ) ||
      null;

    const timestamp =
      Math.max(
        0,
        Number(
          updatedAt
        ) ||
        0
      );

    await chrome.storage.local.set({
      [PRESETS_KEY]:
        normalized,

      [ACTIVE_KEY]:
        activeId,

      [STORE_VERSION_KEY]:
        STORE_VERSION,

      [LOCAL_SYNC_META_KEY]: {
        version:
          SYNC_PAYLOAD_VERSION,

        updatedAt:
          timestamp
      }
    });

    await mirrorPreset(
      activePreset
    );

    return {
      presets:
        normalized,

      activePresetId:
        activeId,

      activePreset,

      updatedAt:
        timestamp
    };
  }

  async function hydrateFromSync() {
    if (
      syncHydrationPromise
    ) {
      return syncHydrationPromise;
    }

    syncHydrationPromise =
      (
        async () => {
          const result =
            await readSyncPayload();

          if (
            result.status !==
              "ok" ||
            !result.payload
          ) {
            return null;
          }

          const local =
            await chrome.storage.local.get([
              PRESETS_KEY,
              ACTIVE_KEY,
              LOCAL_SYNC_META_KEY
            ]);

          const hasLocal =
            Array.isArray(
              local[
                PRESETS_KEY
              ]
            );

          const localUpdatedAt =
            Math.max(
              0,
              Number(
                local[
                  LOCAL_SYNC_META_KEY
                ]?.updatedAt ||
                0
              )
            );

          const syncUpdatedAt =
            Math.max(
              0,
              Number(
                result
                  .payload
                  .updatedAt ||
                0
              )
            );

          if (
            hasLocal &&
            localUpdatedAt >
              syncUpdatedAt &&
            result.payload.reset !== true
          ) {
            const state =
              await writeLocalState(
                local[
                  PRESETS_KEY
                ],
                local[
                  ACTIVE_KEY
                ],
                localUpdatedAt
              );

            await writeSyncPayload(
              state.presets,
              state.activePresetId,
              localUpdatedAt
            );

            return state;
          }

          return writeLocalState(
            result.payload.presets,
            result.payload.activePresetId,
            syncUpdatedAt
          );
        }
      )();

    try {
      return await syncHydrationPromise;
    } finally {
      syncHydrationPromise =
        null;
    }
  }

  function installSyncListener() {
    if (
      syncListenerInstalled
    ) {
      return;
    }

    syncListenerInstalled =
      true;

    chrome.storage.onChanged.addListener(
      (
        changes,
        areaName
      ) => {
        if (
          areaName !==
            "sync"
        ) {
          return;
        }

        const relevant =
          Boolean(
            changes[
              SYNC_META_KEY
            ]
          ) ||
          Object.keys(
            changes
          ).some(
            (key) =>
              key.startsWith(
                SYNC_CHUNK_PREFIX
              )
          );

        if (!relevant || syncWriteDepth > 0) {
          return;
        }

        void hydrateFromSync();
      }
    );
  }

  async function writeState(
    presets,
    activePresetId = ""
  ) {
    const updatedAt =
      Date.now();

    const state =
      await writeLocalState(
        presets,
        activePresetId,
        updatedAt
      );

    await writeSyncPayload(
      state.presets,
      state.activePresetId,
      updatedAt,
      state.presets.length === 0
    );

    return state;
  }

  async function migrateLegacy() {
    installSyncListener();

    const syncResult =
      await readSyncPayload();

    if (syncResult.status === "error") {
      await setSyncWarning(
        "Could not read Chrome Sync presets. Local data is preserved."
      );
    } else if (syncResult.status === "ok") {
      await setSyncWarning("");
    }

    const data =
      await chrome.storage.local.get([
        PRESETS_KEY,
        ACTIVE_KEY,
        LOCAL_SYNC_META_KEY,
        "notionDataSourceId",
        "notionTitleProperty",
        "notionUrlProperty",
        "notionWorkspaceId",
        "notionWorkspaceName",
        "notionWorkspaceUserId",
        "notionWorkspaceSpaceViewIds"
      ]);

    const hasLocalPresets =
      Array.isArray(
        data[
          PRESETS_KEY
        ]
      );

    const localUpdatedAt =
      Math.max(
        0,
        Number(
          data[
            LOCAL_SYNC_META_KEY
          ]?.updatedAt ||
          0
        )
      );

    if (
      syncResult.status ===
        "ok" &&
      syncResult.payload
    ) {
      const syncUpdatedAt =
        Math.max(
          0,
          Number(
            syncResult
              .payload
              .updatedAt ||
            0
          )
        );

      if (
        hasLocalPresets &&
        localUpdatedAt >
          syncUpdatedAt &&
        syncResult.payload.reset !== true
      ) {
        const state =
          await writeLocalState(
            data[
              PRESETS_KEY
            ],
            data[
              ACTIVE_KEY
            ],
            localUpdatedAt
          );

        await writeSyncPayload(
          state.presets,
          state.activePresetId,
          localUpdatedAt
        );

        return state;
      }

      const restored = await writeLocalState(
        syncResult.payload.presets,
        syncResult.payload.activePresetId,
        syncUpdatedAt
      );

      // Upgrade a complete legacy snapshot without changing its presets.
      if (!syncResult.generation) {
        await writeSyncPayload(
          restored.presets,
          restored.activePresetId,
          syncUpdatedAt,
          syncResult.payload.reset === true
        );
      }

      return restored;
    }

    if (
      hasLocalPresets
    ) {
      if (
        syncResult.status === "error" ||
        (normalizePresets(data[PRESETS_KEY]).length === 0 &&
         localUpdatedAt === 0)
      ) {
        return writeLocalState(
          data[
            PRESETS_KEY
          ],
          data[
            ACTIVE_KEY
          ],
          localUpdatedAt
        );
      }

      return writeState(
        data[
          PRESETS_KEY
        ],
        data[
          ACTIVE_KEY
        ]
      );
    }

    const hasLegacyDestination =
      Boolean(
        cleanText(
          data.notionDataSourceId
        )
      );

    if (!hasLegacyDestination) {
      if (
        syncResult.status ===
          "error"
      ) {
        return writeLocalState(
          [],
          "",
          0
        );
      }

      return writeLocalState([], "", 0);
    }

    const preset =
      normalizePreset({
        name:
          "Default",

        workspaceId:
          data.notionWorkspaceId ||
          "",

        workspaceName:
          data.notionWorkspaceName ||
          "",

        workspaceUserId:
          data.notionWorkspaceUserId ||
          "",

        workspaceSpaceViewIds:
          data
            .notionWorkspaceSpaceViewIds ||
          [],

        dataSourceId:
          data.notionDataSourceId ||
          "",

        titleProperty:
          data.notionTitleProperty ||
          "Name",

        urlProperty:
          data.notionUrlProperty ||
          ""
      });

    if (
      syncResult.status ===
        "error"
    ) {
      return writeLocalState(
        [
          preset
        ],
        preset.id,
        0
      );
    }

    return writeState(
      [
        preset
      ],
      preset.id
    );
  }

  async function getState() {
    await migrateLegacy();

    const data =
      await chrome.storage.local.get([
        PRESETS_KEY,
        ACTIVE_KEY
      ]);

    const presets =
      normalizePresets(
        data[PRESETS_KEY]
      );

    let activePresetId =
      cleanText(
        data[ACTIVE_KEY]
      );

    if (
      !presets.some(
        (preset) =>
          preset.id ===
          activePresetId
      )
    ) {
      activePresetId =
        presets[0]
          ?.id ||
        "";
    }

    return {
      presets,

      activePresetId,

      activePreset:
        presets.find(
          (preset) =>
            preset.id ===
            activePresetId
        ) ||
        null
    };
  }

  async function listPresets() {
    const state =
      await getState();

    return {
      presets:
        state.presets,

      activePresetId:
        state.activePresetId
    };
  }

  async function getActivePreset() {
    return (
      await getState()
    ).activePreset;
  }

  async function setActivePreset(
    id
  ) {
    const state =
      await getState();

    const target =
      state.presets.find(
        (preset) =>
          preset.id ===
          id
      );

    if (!target) {
      throw new Error(
        "That Notion preset no longer exists."
      );
    }

    if (state.activePresetId === target.id) {
      return target;
    }

    await writeState(
      state.presets,
      target.id
    );

    return target;
  }

  async function createPreset(
    initial = {}
  ) {
    const state =
      await getState();

    const raw =
      typeof initial ===
        "string"
        ? {
            name:
              initial
          }
        : {
            ...initial
          };

    const preset =
      normalizePreset({
        name:
          "New preset",

        presetIcon:
          "clipnest:knowledge",

        workspaceId:
          "",

        workspaceName:
          "",

        workspaceUserId:
          "",

        workspaceSpaceViewIds:
          [],

        dataSourceId:
          "",

        destinationType:
          "",

        destinationId:
          "",

        destinationName:
          "",

        destinationIcon:
          "",

        destinationParents:
          [],

        destinationParentId:
          "",

        destinationParentTable:
          "",

        propertyIds: {
          title:
            "",

          url:
            "",

          tags:
            ""
        },

        titleProperty:
          "Name",

        urlProperty:
          "",

        tagsProperty:
          "",

        propertyDefaults:
          {},

        popupProperties:
          [],

        ...raw,

        id:
          createId()
      });

    await writeState(
      [
        ...state.presets,
        preset
      ],
      preset.id
    );

    return preset;
  }

  async function updatePreset(
    id,
    patch = {}
  ) {
    const state =
      await getState();

    const index =
      state.presets.findIndex(
        (preset) =>
          preset.id ===
          id
      );

    if (index < 0) {
      throw new Error(
        "That Notion preset no longer exists."
      );
    }

    const current =
      state.presets[
        index
      ];

    const next =
      normalizePreset({
        ...current,
        ...patch,

        id:
          current.id,

        propertyMappings: {
          ...current
            .propertyMappings,

          ...(
            patch.propertyMappings &&
            typeof patch.propertyMappings ===
              "object"
              ? patch.propertyMappings
              : {}
          )
        },

        propertyIds: {
          ...current.propertyIds,

          ...(
            patch.propertyIds &&
            typeof patch.propertyIds ===
              "object"
              ? patch.propertyIds
              : {}
          )
        },

        propertyDefaults:
          patch.propertyDefaults ??
          current.propertyDefaults,

        popupProperties:
          patch.popupProperties ??
          current.popupProperties
      });

    const presets = [
      ...state.presets
    ];

    presets[index] =
      next;

    await writeState(
      presets,
      state.activePresetId
    );

    return next;
  }

  async function updateActivePreset(
    patch = {}
  ) {
    const active =
      await getActivePreset();

    if (!active) {
      throw new Error(
        "Create a Notion preset first."
      );
    }

    return updatePreset(
      active.id,
      patch
    );
  }

  async function removePreset(
    id
  ) {
    const state =
      await getState();

    const exists =
      state.presets.some(
        (preset) =>
          preset.id ===
          id
      );

    if (!exists) {
      throw new Error(
        "That Notion preset no longer exists."
      );
    }

    const presets =
      state.presets.filter(
        (preset) =>
          preset.id !==
          id
      );

    const activePresetId =
      state.activePresetId ===
        id
        ? (
            presets[0]
              ?.id ||
            ""
          )
        : state.activePresetId;

    return writeState(
      presets,
      activePresetId
    );
  }

  async function replacePresets(
    presets,
    activePresetId = ""
  ) {
    if (
      !Array.isArray(
        presets
      )
    ) {
      throw new Error(
        "Imported Notion presets are invalid."
      );
    }

    return writeState(
      presets,
      activePresetId
    );
  }

  async function resetSyncedPresets() {
    const resetAt = Date.now();

    if (!await writeSyncPayload([], "", resetAt, true)) {
      throw new Error(
        "Chrome Sync could not save the reset. Settings were not cleared."
      );
    }

    const verified = await readSyncPayload();

    if (verified.status !== "ok" ||
        verified.payload.updatedAt !== resetAt ||
        verified.payload.presets.length !== 0 ||
        verified.payload.reset !== true) {
      throw new Error("Could not verify the Chrome Sync reset.");
    }

    return resetAt;
  }

  async function finishReset(resetAt) {
    return writeLocalState([], "", resetAt);
  }

  globalThis.ClipNestNotionStore =
    Object.freeze({
      resetSyncedPresets,
      finishReset,
      migrateLegacy,
      listPresets,
      replacePresets,
      getActivePreset,
      setActivePreset,
      activatePreset:
        setActivePreset,
      createPreset,
      updatePreset,
      updateActivePreset,
      removePreset
    });
})();
