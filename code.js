figma.showUI(__html__, {
  width: 440,
  height: 760,
  themeColors: true
});


/* =========================================================
   SCREEN LAYER CLEANER
   Depth Batch Architecture

   핵심 원칙

   1. Original에는 직접 작업하지 않는다.
   2. Working Copy에서만 작업한다.
   3. 구조 변경 Phase는 Depth 단위 Batch 처리한다.
   4. Batch 실패 시 해당 Batch만 Rollback한다.
   5. 구조 변경 후 기존 Plan은 폐기한다.
   6. 다음 작업은 현재 Tree를 다시 Scan한다.
   7. Font → Inter는 명시적 Visual Change이므로
      PNG Rollback 대상에서 제외한다.
========================================================= */


/* =========================================================
   OPTIONS / STATE
========================================================= */

let renameTextToHyphen = false;
let convertFontToInter = false;
let renameContainers = false;

let approvedGarbageIds = new Set();
let analyzedRootIds = [];

const WORK_OFFSET_X = 30000;
const CHECKPOINT_OFFSET_X = 60000;

const ROW_Y_TOLERANCE = 6;

const MAX_INSTANCE_ROUNDS = 10;
const MAX_SCREENSHOT_ROUNDS = 10;
const MAX_FLATTEN_ROUNDS = 30;


/* =========================================================
   PLUGIN DATA
========================================================= */

const PD_GARBAGE_ID =
  "slc_garbage_id";

const PD_GARBAGE_TASK =
  "slc_garbage_task";

const PD_INSTANCE_TASK =
  "slc_instance_task";

const PD_SCREENSHOT_TASK =
  "slc_screenshot_task";

const PD_FLATTEN_TASK =
  "slc_flatten_task";

const PD_INTER_TASK =
  "slc_inter_task";

const PD_SKIP_DETACH =
  "slc_skip_detach";

const PD_SKIP_SCREENSHOT =
  "slc_skip_screenshot";

const PD_SKIP_FLATTEN =
  "slc_skip_flatten";


/* =========================================================
   STATS
========================================================= */

function createStats() {
  return {
    detachedInstances: 0,
    rejectedInstances: 0,

    removedGarbage: 0,
    protectedGarbage: 0,

    removedContainers: 0,
    movedLayers: 0,

    flattenedContainers: 0,
    flattenRejected: 0,

    fastGarbage: 0,
    fastFlatten: 0,

    screenshotBaked: 0,
    screenshotRejected: 0,

    rootConverted: 0,
    rootConversionRejected: 0,

    convertedTexts: 0,
    convertedFontSegments: 0,
    failedFontConversions: 0,

    renamedLayers: 0,
    renameSkipped: 0,

    orderChanged: 0,
    orderRejected: 0,

    preservedAreas: 0,

    visualShells: 0,
    bakedAreas: 0,

    finalLayers: 0,

    treeScans: 0,
    visualBatchChecks: 0,
    batchRollbacks: 0,

    report: []
  };
}


/* =========================================================
   REPORT
========================================================= */

function addReport(
  stats,
  action,
  status,
  node,
  reason
) {
  const entry = {
    action,

    status,

    node:
      node && isAlive(node)
        ? safeName(node)
        : "",

    type:
      node && isAlive(node)
        ? safeType(node)
        : "",

    reason:
      reason || ""
  };


  stats.report.push(entry);


  const symbol =
    status === "SUCCESS"
      ? "✓"
      : status === "SKIPPED"
        ? "→"
        : "✕";


  console.log(
    `[Screen Layer Cleaner] ${symbol} ${action}`,
    entry.node,
    entry.reason
  );
}


/* =========================================================
   SAFE HELPERS
========================================================= */

function safeType(node) {
  try {
    return node ? node.type : null;
  } catch (_) {
    return null;
  }
}


function safeName(node) {
  try {
    return node ? node.name : "";
  } catch (_) {
    return "";
  }
}


function safeId(node) {
  try {
    return node ? node.id : null;
  } catch (_) {
    return null;
  }
}


function safeParent(node) {
  try {
    return node ? node.parent : null;
  } catch (_) {
    return null;
  }
}


function isAlive(node) {
  try {
    return !!(
      node &&
      node.parent
    );
  } catch (_) {
    return false;
  }
}


function childrenOf(node) {
  try {
    if (!isAlive(node)) {
      return [];
    }

    if ("children" in node) {
      return [...node.children];
    }

    return [];
  } catch (_) {
    return [];
  }
}


function safeBounds(node) {
  try {
    return (
      node.absoluteBoundingBox ||
      null
    );
  } catch (_) {
    return null;
  }
}


function safeRenderBounds(node) {
  try {
    return (
      node.absoluteRenderBounds ||
      node.absoluteBoundingBox ||
      null
    );
  } catch (_) {
    return null;
  }
}


function safeTransform(node) {
  try {
    return (
      node.absoluteTransform ||
      null
    );
  } catch (_) {
    return null;
  }
}


function safeRemove(node) {
  try {
    if (!isAlive(node)) {
      return false;
    }

    node.remove();

    return true;
  } catch (_) {
    return false;
  }
}


/* =========================================================
   TYPE HELPERS
========================================================= */

function isContainer(node) {
  return [
    "FRAME",
    "GROUP",
    "COMPONENT",
    "INSTANCE"
  ].includes(
    safeType(node)
  );
}


function isSupportedRoot(node) {
  return isContainer(node);
}


function isAutoLayout(node) {
  try {
    return (
      isAlive(node) &&
      "layoutMode" in node &&
      node.layoutMode !== "NONE"
    );
  } catch (_) {
    return false;
  }
}


function participatesInAutoLayout(node) {
  const parent =
    safeParent(node);


  if (
    !parent ||
    !isAutoLayout(parent)
  ) {
    return false;
  }


  try {
    return !(
      "layoutPositioning" in node &&
      node.layoutPositioning === "ABSOLUTE"
    );
  } catch (_) {
    return true;
  }
}


/* =========================================================
   MATRIX
========================================================= */

function multiplyTransform(
  a,
  b
) {
  return [
    [
      a[0][0] * b[0][0] +
        a[0][1] * b[1][0],

      a[0][0] * b[0][1] +
        a[0][1] * b[1][1],

      a[0][0] * b[0][2] +
        a[0][1] * b[1][2] +
        a[0][2]
    ],

    [
      a[1][0] * b[0][0] +
        a[1][1] * b[1][0],

      a[1][0] * b[0][1] +
        a[1][1] * b[1][1],

      a[1][0] * b[0][2] +
        a[1][1] * b[1][2] +
        a[1][2]
    ]
  ];
}


function invertTransform(m) {
  const a = m[0][0];
  const c = m[0][1];
  const e = m[0][2];

  const b = m[1][0];
  const d = m[1][1];
  const f = m[1][2];


  const det =
    a * d -
    b * c;


  if (
    Math.abs(det) <
    0.000001
  ) {
    throw new Error(
      "Transform matrix cannot be inverted."
    );
  }


  const inv =
    1 / det;


  return [
    [
      d * inv,
      -c * inv,
      (
        c * f -
        d * e
      ) * inv
    ],

    [
      -b * inv,
      a * inv,
      (
        b * e -
        a * f
      ) * inv
    ]
  ];
}


function absoluteToRelative(
  absoluteTransform,
  parent
) {
  const parentTransform =
    safeTransform(parent);


  if (!parentTransform) {
    throw new Error(
      "Parent transform unavailable."
    );
  }


  return multiplyTransform(
    invertTransform(
      parentTransform
    ),
    absoluteTransform
  );
}


/* =========================================================
   PLUGIN DATA
========================================================= */

function getPD(
  node,
  key
) {
  try {
    if (!isAlive(node)) {
      return "";
    }

    return (
      node.getPluginData(key) ||
      ""
    );
  } catch (_) {
    return "";
  }
}


function setPD(
  node,
  key,
  value
) {
  try {
    if (isAlive(node)) {
      node.setPluginData(
        key,
        value
      );
    }
  } catch (_) {}
}


function clearPluginKey(
  root,
  key
) {
  function walk(node) {
    if (!isAlive(node)) {
      return;
    }


    setPD(
      node,
      key,
      ""
    );


    for (
      const child of
      childrenOf(node)
    ) {
      walk(child);
    }
  }


  walk(root);
}


function findByPluginData(
  root,
  key,
  value
) {
  let found =
    null;


  function walk(node) {
    if (
      found ||
      !isAlive(node)
    ) {
      return;
    }


    if (
      getPD(
        node,
        key
      ) === value
    ) {
      found =
        node;

      return;
    }


    for (
      const child of
      childrenOf(node)
    ) {
      walk(child);

      if (found) {
        return;
      }
    }
  }


  walk(root);

  return found;
}


function clearInternalPluginData(root) {
  const keys = [
    PD_GARBAGE_ID,
    PD_GARBAGE_TASK,
    PD_INSTANCE_TASK,
    PD_SCREENSHOT_TASK,
    PD_FLATTEN_TASK,
    PD_INTER_TASK,
    PD_SKIP_DETACH,
    PD_SKIP_SCREENSHOT,
    PD_SKIP_FLATTEN
  ];


  function walk(node) {
    if (!isAlive(node)) {
      return;
    }


    for (
      const key of keys
    ) {
      setPD(
        node,
        key,
        ""
      );
    }


    for (
      const child of
      childrenOf(node)
    ) {
      walk(child);
    }
  }


  walk(root);
}


/* =========================================================
   MARKER
========================================================= */

let taskCounter =
  0;


function createTaskMarker(prefix) {
  taskCounter++;


  return (
    `${prefix}_${Date.now()}_${taskCounter}`
  );
}


/* =========================================================
   PATH MAP
========================================================= */

function createPathMap(root) {
  const map =
    new Map();


  function walk(
    node,
    path
  ) {
    if (!isAlive(node)) {
      return;
    }


    const id =
      safeId(node);


    if (id) {
      map.set(
        id,
        [...path]
      );
    }


    const children =
      childrenOf(node);


    for (
      let i = 0;
      i < children.length;
      i++
    ) {
      walk(
        children[i],
        [...path, i]
      );
    }
  }


  walk(
    root,
    []
  );


  return map;
}


function resolvePath(
  root,
  path
) {
  let current =
    root;


  for (
    const index of path
  ) {
    const children =
      childrenOf(current);


    if (
      index < 0 ||
      index >= children.length
    ) {
      return null;
    }


    current =
      children[index];


    if (!isAlive(current)) {
      return null;
    }
  }


  return current;
}


/* =========================================================
   PNG
========================================================= */

async function exportNodePng(node) {
  if (!isAlive(node)) {
    return null;
  }


  try {
    return await node.exportAsync({
      format:
        "PNG",

      constraint: {
        type:
          "SCALE",

        value:
          1
      }
    });
  } catch (_) {
    return null;
  }
}


function sameBytes(
  a,
  b
) {
  if (
    !a ||
    !b ||
    a.length !== b.length
  ) {
    return false;
  }


  for (
    let i = 0;
    i < a.length;
    i++
  ) {
    if (
      a[i] !== b[i]
    ) {
      return false;
    }
  }


  return true;
}


/* =========================================================
   WORK COPY
========================================================= */

async function createWorkingState(
  originalRoot
) {
  const clone =
    originalRoot.clone();


  figma.currentPage.appendChild(
    clone
  );


  clone.x =
    originalRoot.x +
    WORK_OFFSET_X;


  clone.y =
    originalRoot.y;


  return {
    root:
      clone
  };
}


/* =========================================================
   VISUAL BATCH TRANSACTION

   Batch 전체를 1번만 검증.

   실패해도 Screen 전체를 실패시키지 않는다.
   해당 Batch만 checkpoint로 되돌린다.
========================================================= */

async function runVisualBatchTransaction(
  state,
  tasks,
  markerKey,
  mutateTask,
  stats
) {
  if (
    !tasks ||
    tasks.length === 0 ||
    !isAlive(state.root)
  ) {
    return {
      changed: false,
      accepted: true,
      reason: "empty"
    };
  }


  stats.visualBatchChecks++;


  const originalRoot =
    state.root;


  const rootX =
    originalRoot.x;

  const rootY =
    originalRoot.y;


  const before =
    await exportNodePng(
      originalRoot
    );


  if (!before) {
    return {
      changed: false,
      accepted: false,
      reason:
        "before-render-failed"
    };
  }


  let checkpoint;


  try {
    checkpoint =
      originalRoot.clone();


    figma.currentPage.appendChild(
      checkpoint
    );


    checkpoint.x =
      rootX +
      CHECKPOINT_OFFSET_X;


    checkpoint.y =
      rootY;

  } catch (error) {
    return {
      changed: false,
      accepted: false,
      reason:
        "checkpoint-failed",
      error
    };
  }


  let changed =
    false;


  const results =
    [];


  try {
    for (
      const task of tasks
    ) {
      const node =
        findByPluginData(
          state.root,
          markerKey,
          task.marker
        );


      if (!node) {
        results.push({
          task,
          changed: false,
          reason:
            "node-missing"
        });

        continue;
      }


      const result =
        await mutateTask(
          state.root,
          node,
          task
        );


      results.push({
        task,
        ...result
      });


      if (
        result &&
        result.root &&
        isAlive(result.root)
      ) {
        state.root =
          result.root;
      }


      if (
        result &&
        result.changed
      ) {
        changed =
          true;
      }
    }

  } catch (error) {
    if (
      state.root &&
      isAlive(state.root)
    ) {
      safeRemove(
        state.root
      );
    }


    checkpoint.x =
      rootX;

    checkpoint.y =
      rootY;


    state.root =
      checkpoint;


    stats.batchRollbacks++;


    return {
      changed,
      accepted: false,
      reason:
        "operation-error",
      error,
      results
    };
  }


  if (!changed) {
    safeRemove(
      checkpoint
    );


    return {
      changed: false,
      accepted: true,
      reason:
        "no-change",
      results
    };
  }


  const after =
    await exportNodePng(
      state.root
    );


  if (
    after &&
    sameBytes(
      before,
      after
    )
  ) {
    safeRemove(
      checkpoint
    );


    return {
      changed: true,
      accepted: true,
      reason:
        "visual-identical",
      results
    };
  }


  /*
   * Batch only rollback
   */

  if (
    state.root &&
    isAlive(state.root)
  ) {
    safeRemove(
      state.root
    );
  }


  checkpoint.x =
    rootX;

  checkpoint.y =
    rootY;


  state.root =
    checkpoint;


  stats.batchRollbacks++;


  return {
    changed: true,
    accepted: false,
    reason:
      after
        ? "visual-changed"
        : "after-render-failed",
    results
  };
}


/* =========================================================
   SINGLE TRANSACTION
========================================================= */

async function runSingleVisualTransaction(
  state,
  mutate,
  stats
) {
  const marker =
    createTaskMarker(
      "single"
    );


  setPD(
    state.root,
    PD_FLATTEN_TASK,
    marker
  );


  const result =
    await runVisualBatchTransaction(
      state,
      [
        {
          marker
        }
      ],
      PD_FLATTEN_TASK,
      async (
        root,
        node
      ) =>
        await mutate(
          root,
          node
        ),
      stats
    );


  clearPluginKey(
    state.root,
    PD_FLATTEN_TASK
  );


  return result;
}


/* =========================================================
   LID
========================================================= */

function isLidName(name) {
  const value =
    String(
      name ||
      ""
    )
      .trim()
      .toLowerCase();


  return (
    value.startsWith(
      "cci_ctn_"
    ) ||
    value.startsWith(
      "cci_msg_"
    ) ||
    value.startsWith(
      "ctn_"
    ) ||
    value.startsWith(
      "msg_"
    )
  );
}


/* =========================================================
   PAINT
========================================================= */

function hasVisiblePaint(paints) {
  return (
    Array.isArray(paints) &&
    paints.some(
      paint =>
        paint.visible !== false &&
        !(
          typeof paint.opacity ===
            "number" &&
          paint.opacity === 0
        )
    )
  );
}


function hasVisibleFill(node) {
  try {
    return (
      "fills" in node &&
      node.fills !== figma.mixed &&
      hasVisiblePaint(
        node.fills
      )
    );
  } catch (_) {
    return false;
  }
}


function hasVisibleStroke(node) {
  try {
    return (
      "strokes" in node &&
      node.strokes !== figma.mixed &&
      hasVisiblePaint(
        node.strokes
      )
    );
  } catch (_) {
    return false;
  }
}


function hasVisibleEffects(node) {
  try {
    return (
      "effects" in node &&
      Array.isArray(
        node.effects
      ) &&
      node.effects.some(
        effect =>
          effect.visible !== false
      )
    );
  } catch (_) {
    return false;
  }
}


function hasOwnVisual(node) {
  return (
    hasVisibleFill(node) ||
    hasVisibleStroke(node) ||
    hasVisibleEffects(node)
  );
}


function hasImageFill(node) {
  try {
    return (
      "fills" in node &&
      node.fills !== figma.mixed &&
      Array.isArray(
        node.fills
      ) &&
      node.fills.some(
        paint =>
          paint.type === "IMAGE" &&
          paint.visible !== false
      )
    );
  } catch (_) {
    return false;
  }
}


/* =========================================================
   MASK / CLIP
========================================================= */

function isMaskNode(node) {
  try {
    return (
      "isMask" in node &&
      node.isMask === true
    );
  } catch (_) {
    return false;
  }
}


function containsMask(node) {
  for (
    const child of
    childrenOf(node)
  ) {
    if (
      isMaskNode(child) ||
      containsMask(child)
    ) {
      return true;
    }
  }

  return false;
}


function actuallyClipsChildren(node) {
  try {
    if (
      !(
        "clipsContent" in node
      ) ||
      node.clipsContent !== true
    ) {
      return false;
    }
  } catch (_) {
    return false;
  }


  const box =
    safeBounds(node);


  if (!box) {
    return true;
  }


  const right =
    box.x +
    box.width;


  const bottom =
    box.y +
    box.height;


  for (
    const child of
    childrenOf(node)
  ) {
    const childBox =
      safeRenderBounds(child);


    if (!childBox) {
      continue;
    }


    if (
      childBox.x <
        box.x - 0.5 ||

      childBox.y <
        box.y - 0.5 ||

      childBox.x +
        childBox.width >
        right + 0.5 ||

      childBox.y +
        childBox.height >
        bottom + 0.5
    ) {
      return true;
    }
  }


  return false;
}


/* =========================================================
   SHAPE / GARBAGE
========================================================= */

function isShapeNode(node) {
  return [
    "RECTANGLE",
    "ELLIPSE",
    "POLYGON",
    "STAR",
    "VECTOR",
    "BOOLEAN_OPERATION",
    "LINE"
  ].includes(
    safeType(node)
  );
}


function isTinyNode(node) {
  try {
    return (
      node.width <= 0.1 ||
      node.height <= 0.1
    );
  } catch (_) {
    return false;
  }
}


function isEmptyVisualShape(node) {
  return (
    isShapeNode(node) &&
    !isMaskNode(node) &&
    !hasVisibleFill(node) &&
    !hasVisibleStroke(node) &&
    !hasVisibleEffects(node)
  );
}


function isEmptyContainer(node) {
  return (
    isContainer(node) &&
    childrenOf(node).length === 0 &&
    !hasVisibleFill(node) &&
    !hasVisibleStroke(node) &&
    !hasVisibleEffects(node)
  );
}


function isOutsideRoot(
  node,
  root
) {
  const a =
    safeRenderBounds(node);

  const b =
    safeBounds(root);


  if (
    !a ||
    !b ||
    node === root
  ) {
    return false;
  }


  return (
    a.x + a.width <= b.x ||
    a.x >= b.x + b.width ||
    a.y + a.height <= b.y ||
    a.y >= b.y + b.height
  );
}


function getGarbageReason(
  node,
  root
) {
  if (
    !isAlive(node) ||
    node === root
  ) {
    return null;
  }


  try {
    if (
      "visible" in node &&
      node.visible === false
    ) {
      return (
        "Hidden · visible=false"
      );
    }
  } catch (_) {}


  try {
    if (
      "opacity" in node &&
      node.opacity === 0
    ) {
      return (
        "Transparent · opacity=0"
      );
    }
  } catch (_) {}


  if (
    safeType(node) === "SLICE"
  ) {
    return "Slice";
  }


  if (isTinyNode(node)) {
    return (
      "Zero / Tiny Size"
    );
  }


  if (
    isEmptyVisualShape(node)
  ) {
    return (
      "Empty Shape"
    );
  }


  if (
    isEmptyContainer(node)
  ) {
    return (
      "Empty Container"
    );
  }


  if (
    isOutsideRoot(
      node,
      root
    ) &&
    !isMaskNode(node)
  ) {
    return (
      "Outside Screen"
    );
  }


  return null;
}


function isFastSafeGarbage(
  node,
  root
) {
  if (
    !isAlive(node) ||
    node === root ||
    isMaskNode(node) ||
    participatesInAutoLayout(node)
  ) {
    return false;
  }


  try {
    if (
      "visible" in node &&
      node.visible === false
    ) {
      return true;
    }
  } catch (_) {}


  if (
    isEmptyVisualShape(node) ||
    isEmptyContainer(node)
  ) {
    return true;
  }


  if (
    isOutsideRoot(
      node,
      root
    )
  ) {
    try {
      return (
        "clipsContent" in root &&
        root.clipsContent === true
      );
    } catch (_) {}
  }


  return false;
}


/* =========================================================
   ANALYZE GARBAGE
========================================================= */

function collectGarbageItems(root) {
  const items =
    [];


  function walk(
    node,
    path
  ) {
    if (!isAlive(node)) {
      return;
    }


    const name =
      safeName(node);


    const currentPath =
      path
        ? `${path} / ${name}`
        : name;


    const reason =
      getGarbageReason(
        node,
        root
      );


    if (reason) {
      items.push({
        id:
          safeId(node),

        name,

        type:
          safeType(node),

        reason,

        path:
          currentPath
      });
    }


    for (
      const child of
      childrenOf(node)
    ) {
      walk(
        child,
        currentPath
      );
    }
  }


  walk(
    root,
    ""
  );


  return items;
}


/* =========================================================
   SELECTED GARBAGE
========================================================= */

function markSelectedGarbage(
  originalRoot,
  workRoot
) {
  const map =
    createPathMap(
      originalRoot
    );


  for (
    const id of
    approvedGarbageIds
  ) {
    const path =
      map.get(id);


    if (!path) {
      continue;
    }


    const node =
      resolvePath(
        workRoot,
        path
      );


    if (node) {
      setPD(
        node,
        PD_GARBAGE_ID,
        id
      );
    }
  }
}


function buildGarbageTasks(
  root,
  stats
) {
  stats.treeScans++;


  clearPluginKey(
    root,
    PD_GARBAGE_TASK
  );


  const tasks =
    [];


  function walk(
    node,
    selectedAncestor
  ) {
    if (!isAlive(node)) {
      return;
    }


    const selected =
      !!getPD(
        node,
        PD_GARBAGE_ID
      ) &&
      !!getGarbageReason(
        node,
        root
      );


    if (
      selected &&
      !selectedAncestor
    ) {
      const marker =
        createTaskMarker(
          "garbage"
        );


      setPD(
        node,
        PD_GARBAGE_TASK,
        marker
      );


      tasks.push({
        marker,

        name:
          safeName(node),

        type:
          safeType(node),

        reason:
          getGarbageReason(
            node,
            root
          ),

        fast:
          isFastSafeGarbage(
            node,
            root
          )
      });
    }


    for (
      const child of
      childrenOf(node)
    ) {
      walk(
        child,
        selectedAncestor ||
        selected
      );
    }
  }


  walk(
    root,
    false
  );


  return tasks;
}


/* =========================================================
   GARBAGE PHASE
========================================================= */

async function processGarbage(
  state,
  stats
) {
  let tasks =
    buildGarbageTasks(
      state.root,
      stats
    );


  /*
   * 확실히 안전한 Garbage
   */

  for (
    const task of
    tasks.filter(
      task =>
        task.fast
    )
  ) {
    const node =
      findByPluginData(
        state.root,
        PD_GARBAGE_TASK,
        task.marker
      );


    if (
      node &&
      safeRemove(node)
    ) {
      stats.fastGarbage++;
      stats.removedGarbage++;


      addReport(
        stats,
        "Garbage",
        "SUCCESS",
        null,
        `${task.name} · Fast Delete`
      );
    }
  }


  /*
   * Tree changed → re-scan
   */

  tasks =
    buildGarbageTasks(
      state.root,
      stats
    );


  const risky =
    tasks.filter(
      task =>
        !task.fast
    );


  if (
    risky.length === 0
  ) {
    return;
  }


  const tx =
    await runVisualBatchTransaction(
      state,
      risky,
      PD_GARBAGE_TASK,

      async (
        root,
        node
      ) => ({
        root,

        changed:
          safeRemove(node)
      }),

      stats
    );


  if (tx.accepted) {
    stats.removedGarbage +=
      risky.length;


    for (
      const task of risky
    ) {
      addReport(
        stats,
        "Garbage",
        "SUCCESS",
        null,
        `${task.name} · Batch`
      );
    }

  } else {
    stats.protectedGarbage +=
      risky.length;


    for (
      const task of risky
    ) {
      const node =
        findByPluginData(
          state.root,
          PD_GARBAGE_TASK,
          task.marker
        );


      if (node) {
        setPD(
          node,
          PD_GARBAGE_ID,
          ""
        );
      }


      addReport(
        stats,
        "Garbage",
        "REJECTED",
        node,
        `Batch rollback · ${tx.reason}`
      );
    }
  }
}


/* =========================================================
   FONT LOAD
========================================================= */

const loadedFonts =
  new Set();


async function loadFontOnce(fontName) {
  if (
    !fontName ||
    fontName === figma.mixed
  ) {
    return false;
  }


  const key =
    `${fontName.family}::${fontName.style}`;


  if (
    loadedFonts.has(key)
  ) {
    return true;
  }


  try {
    await figma.loadFontAsync({
      family:
        fontName.family,

      style:
        fontName.style
    });


    loadedFonts.add(key);

    return true;

  } catch (_) {
    return false;
  }
}


/* =========================================================
   INSTANCE DEPTH BATCH
========================================================= */

function buildDeepestInstanceBatch(
  root,
  stats
) {
  stats.treeScans++;


  clearPluginKey(
    root,
    PD_INSTANCE_TASK
  );


  const candidates =
    [];


  function walk(
    node,
    depth
  ) {
    if (!isAlive(node)) {
      return;
    }


    if (
      node !== root &&
      safeType(node) ===
        "INSTANCE" &&
      getPD(
        node,
        PD_SKIP_DETACH
      ) !== "1"
    ) {
      candidates.push({
        node,
        depth
      });


      /*
       * Instance 내부는 detach 후 다음 Scan에서 본다.
       */

      return;
    }


    for (
      const child of
      childrenOf(node)
    ) {
      walk(
        child,
        depth + 1
      );
    }
  }


  walk(
    root,
    0
  );


  if (
    candidates.length === 0
  ) {
    return [];
  }


  const maxDepth =
    Math.max(
      ...candidates.map(
        item =>
          item.depth
      )
    );


  const deepest =
    candidates.filter(
      item =>
        item.depth ===
        maxDepth
    );


  return deepest.map(
    item => {
      const marker =
        createTaskMarker(
          "instance"
        );


      setPD(
        item.node,
        PD_INSTANCE_TASK,
        marker
      );


      return {
        marker,

        depth:
          item.depth,

        name:
          safeName(item.node)
      };
    }
  );
}


async function processInstancePhase(
  state,
  stats
) {
  for (
    let round = 0;
    round < MAX_INSTANCE_ROUNDS;
    round++
  ) {
    const tasks =
      buildDeepestInstanceBatch(
        state.root,
        stats
      );


    if (
      tasks.length === 0
    ) {
      break;
    }


    const tx =
      await runVisualBatchTransaction(
        state,
        tasks,
        PD_INSTANCE_TASK,

        async (
          root,
          node
        ) => {
          if (
            safeType(node) !==
              "INSTANCE"
          ) {
            return {
              root,
              changed: false
            };
          }


          try {
            const detached =
              node.detachInstance();


            return {
              root,
              changed:
                !!detached
            };

          } catch (error) {
            return {
              root,
              changed: false,
              error
            };
          }
        },

        stats
      );


    if (tx.accepted) {
      stats.detachedInstances +=
        tasks.length;


      for (
        const task of tasks
      ) {
        addReport(
          stats,
          "Instance Detach",
          "SUCCESS",
          null,
          `${task.name} · Depth ${task.depth}`
        );
      }

    } else {
      stats.rejectedInstances +=
        tasks.length;

      stats.preservedAreas +=
        tasks.length;


      /*
       * restored checkpoint에 marker가 살아있다.
       */

      for (
        const task of tasks
      ) {
        const node =
          findByPluginData(
            state.root,
            PD_INSTANCE_TASK,
            task.marker
          );


        if (node) {
          setPD(
            node,
            PD_SKIP_DETACH,
            "1"
          );
        }


        addReport(
          stats,
          "Instance Detach",
          "REJECTED",
          node,
          `Depth batch rollback · ${tx.reason}`
        );
      }
    }
  }
}


/* =========================================================
   SCREENSHOT DEPTH BATCH
========================================================= */

function buildDeepestScreenshotBatch(
  root,
  stats
) {
  stats.treeScans++;


  clearPluginKey(
    root,
    PD_SCREENSHOT_TASK
  );


  const candidates =
    [];


  function walk(
    node,
    depth
  ) {
    if (!isAlive(node)) {
      return;
    }


    for (
      const child of
      childrenOf(node)
    ) {
      walk(
        child,
        depth + 1
      );
    }


    if (
      node === root ||
      !isContainer(node) ||
      getPD(
        node,
        PD_SKIP_SCREENSHOT
      ) === "1"
    ) {
      return;
    }


    if (
      containsMask(node) ||
      actuallyClipsChildren(node)
    ) {
      candidates.push({
        node,
        depth
      });
    }
  }


  walk(
    root,
    0
  );


  if (
    candidates.length === 0
  ) {
    return [];
  }


  const maxDepth =
    Math.max(
      ...candidates.map(
        item =>
          item.depth
      )
    );


  return candidates
    .filter(
      item =>
        item.depth ===
        maxDepth
    )
    .map(
      item => {
        const marker =
          createTaskMarker(
            "screenshot"
          );


        setPD(
          item.node,
          PD_SCREENSHOT_TASK,
          marker
        );


        return {
          marker,
          depth:
            item.depth,
          name:
            safeName(item.node)
        };
      }
    );
}


/* =========================================================
   SCREENSHOT REPLACE
========================================================= */

async function replaceWithScreenshot(
  root,
  container
) {
  const parent =
    safeParent(container);


  if (
    !parent ||
    !("children" in parent)
  ) {
    return {
      root,
      changed: false
    };
  }


  const bounds =
    safeRenderBounds(
      container
    );


  if (
    !bounds ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    return {
      root,
      changed: false
    };
  }


  const index =
    parent.children.indexOf(
      container
    );


  if (
    index < 0
  ) {
    return {
      root,
      changed: false
    };
  }


  let bytes;


  try {
    bytes =
      await container.exportAsync({
        format:
          "PNG",

        constraint: {
          type:
            "SCALE",

          value:
            1
        }
      });
  } catch (_) {
    return {
      root,
      changed: false
    };
  }


  const image =
    figma.createImage(
      bytes
    );


  const rect =
    figma.createRectangle();


  rect.name =
    "screenshot";


  rect.resize(
    Math.max(
      bounds.width,
      0.01
    ),
    Math.max(
      bounds.height,
      0.01
    )
  );


  rect.fills = [
    {
      type:
        "IMAGE",

      scaleMode:
        "FILL",

      imageHash:
        image.hash
    }
  ];


  try {
    if (
      isAutoLayout(parent)
    ) {
      rect.layoutPositioning =
        "ABSOLUTE";
    }
  } catch (_) {}


  parent.insertChild(
    index,
    rect
  );


  rect.relativeTransform =
    absoluteToRelative(
      [
        [
          1,
          0,
          bounds.x
        ],

        [
          0,
          1,
          bounds.y
        ]
      ],
      parent
    );


  safeRemove(
    container
  );


  return {
    root,
    changed: true
  };
}


/* =========================================================
   SCREENSHOT PHASE
========================================================= */

async function processScreenshotPhase(
  state,
  stats
) {
  for (
    let round = 0;
    round < MAX_SCREENSHOT_ROUNDS;
    round++
  ) {
    const tasks =
      buildDeepestScreenshotBatch(
        state.root,
        stats
      );


    if (
      tasks.length === 0
    ) {
      break;
    }


    const tx =
      await runVisualBatchTransaction(
        state,
        tasks,
        PD_SCREENSHOT_TASK,

        async (
          root,
          node
        ) =>
          await replaceWithScreenshot(
            root,
            node
          ),

        stats
      );


    if (tx.accepted) {
      stats.screenshotBaked +=
        tasks.length;

      stats.bakedAreas +=
        tasks.length;


      for (
        const task of tasks
      ) {
        addReport(
          stats,
          "Screenshot Bake",
          "SUCCESS",
          null,
          `${task.name} · Depth ${task.depth}`
        );
      }

    } else {
      stats.screenshotRejected +=
        tasks.length;

      stats.preservedAreas +=
        tasks.length;


      for (
        const task of tasks
      ) {
        const node =
          findByPluginData(
            state.root,
            PD_SCREENSHOT_TASK,
            task.marker
          );


        if (node) {
          setPD(
            node,
            PD_SKIP_SCREENSHOT,
            "1"
          );
        }


        addReport(
          stats,
          "Screenshot Bake",
          "REJECTED",
          node,
          `Depth batch rollback · ${tx.reason}`
        );
      }
    }
  }
}


/* =========================================================
   FLATTEN
========================================================= */

function isFlattenCandidate(node) {
  return (
    isAlive(node) &&

    [
      "FRAME",
      "GROUP",
      "COMPONENT"
    ].includes(
      safeType(node)
    ) &&

    !containsMask(node) &&

    !actuallyClipsChildren(node) &&

    getPD(
      node,
      PD_SKIP_FLATTEN
    ) !== "1"
  );
}


function isFastFlattenCandidate(node) {
  if (
    !isFlattenCandidate(node)
  ) {
    return false;
  }


  if (
    ![
      "FRAME",
      "GROUP"
    ].includes(
      safeType(node)
    )
  ) {
    return false;
  }


  if (
    isAutoLayout(node) ||
    participatesInAutoLayout(node) ||
    hasOwnVisual(node)
  ) {
    return false;
  }


  try {
    if (
      "opacity" in node &&
      node.opacity !== 1
    ) {
      return false;
    }
  } catch (_) {}


  return true;
}


/* =========================================================
   FLATTEN DEPTH BATCH
========================================================= */

function buildDeepestFlattenBatch(
  root,
  stats
) {
  stats.treeScans++;


  clearPluginKey(
    root,
    PD_FLATTEN_TASK
  );


  const candidates =
    [];


  function walk(
    node,
    depth
  ) {
    if (!isAlive(node)) {
      return;
    }


    for (
      const child of
      childrenOf(node)
    ) {
      walk(
        child,
        depth + 1
      );
    }


    if (
      node === root ||
      !isFlattenCandidate(node)
    ) {
      return;
    }


    candidates.push({
      node,
      depth,
      fast:
        isFastFlattenCandidate(
          node
        )
    });
  }


  walk(
    root,
    0
  );


  if (
    candidates.length === 0
  ) {
    return [];
  }


  const maxDepth =
    Math.max(
      ...candidates.map(
        item =>
          item.depth
      )
    );


  return candidates
    .filter(
      item =>
        item.depth ===
        maxDepth
    )
    .map(
      item => {
        const marker =
          createTaskMarker(
            "flatten"
          );


        setPD(
          item.node,
          PD_FLATTEN_TASK,
          marker
        );


        return {
          marker,

          depth:
            item.depth,

          name:
            safeName(item.node),

          type:
            safeType(item.node),

          fast:
            item.fast
        };
      }
    );
}


/* =========================================================
   VISUAL SHELL
========================================================= */

function createVisualShell(
  source,
  parent,
  index
) {
  const transform =
    safeTransform(source);


  if (!transform) {
    return null;
  }


  const rect =
    figma.createRectangle();


  rect.name =
    "shape";


  try {
    rect.resize(
      Math.max(
        source.width,
        0.01
      ),
      Math.max(
        source.height,
        0.01
      )
    );
  } catch (_) {
    try {
      rect.remove();
    } catch (_) {}

    return null;
  }


  try {
    if (
      source.fills !==
        figma.mixed
    ) {
      rect.fills =
        source.fills;
    }
  } catch (_) {}


  try {
    if (
      source.strokes !==
        figma.mixed
    ) {
      rect.strokes =
        source.strokes;
    }
  } catch (_) {}


  try {
    rect.strokeWeight =
      source.strokeWeight;

    rect.strokeAlign =
      source.strokeAlign;
  } catch (_) {}


  try {
    rect.effects =
      source.effects;
  } catch (_) {}


  try {
    rect.opacity =
      source.opacity;
  } catch (_) {}


  try {
    rect.blendMode =
      source.blendMode;
  } catch (_) {}


  try {
    rect.topLeftRadius =
      source.topLeftRadius;

    rect.topRightRadius =
      source.topRightRadius;

    rect.bottomLeftRadius =
      source.bottomLeftRadius;

    rect.bottomRightRadius =
      source.bottomRightRadius;
  } catch (_) {}


  try {
    if (
      isAutoLayout(parent)
    ) {
      rect.layoutPositioning =
        "ABSOLUTE";
    }
  } catch (_) {}


  try {
    parent.insertChild(
      index,
      rect
    );


    rect.relativeTransform =
      absoluteToRelative(
        transform,
        parent
      );


    return rect;

  } catch (_) {
    try {
      rect.remove();
    } catch (_) {}

    return null;
  }
}


/* =========================================================
   FLATTEN ONE
========================================================= */

async function flattenContainer(
  root,
  container
) {
  const parent =
    safeParent(container);


  if (
    !parent ||
    !("children" in parent)
  ) {
    return {
      root,
      changed: false
    };
  }


  const index =
    parent.children.indexOf(
      container
    );


  if (
    index < 0
  ) {
    return {
      root,
      changed: false
    };
  }


  const children =
    childrenOf(container);


  if (
    children.length === 0
  ) {
    return {
      root,

      changed:
        safeRemove(container),

      moved:
        0,

      removed:
        1,

      shells:
        0
    };
  }


  const snapshots =
    children.map(
      child => ({
        child,

        transform:
          safeTransform(child)
      })
    );


  if (
    snapshots.some(
      item =>
        !item.transform
    )
  ) {
    return {
      root,
      changed: false
    };
  }


  let insertion =
    index;


  let shells =
    0;


  if (
    hasOwnVisual(container)
  ) {
    const shell =
      createVisualShell(
        container,
        parent,
        insertion
      );


    if (shell) {
      shells++;
      insertion++;
    }
  }


  let moved =
    0;


  for (
    const item of snapshots
  ) {
    try {
      if (
        isAutoLayout(parent) &&
        "layoutPositioning" in
          item.child
      ) {
        item.child.layoutPositioning =
          "ABSOLUTE";
      }
    } catch (_) {}


    parent.insertChild(
      insertion,
      item.child
    );


    item.child.relativeTransform =
      absoluteToRelative(
        item.transform,
        parent
      );


    moved++;
    insertion++;
  }


  safeRemove(
    container
  );


  return {
    root,
    changed: true,
    moved,
    removed: 1,
    shells
  };
}


/* =========================================================
   FLATTEN PHASE
========================================================= */

async function processFlattenPhase(
  state,
  stats
) {
  for (
    let round = 0;
    round < MAX_FLATTEN_ROUNDS;
    round++
  ) {
    const tasks =
      buildDeepestFlattenBatch(
        state.root,
        stats
      );


    if (
      tasks.length === 0
    ) {
      break;
    }


    const tx =
      await runVisualBatchTransaction(
        state,
        tasks,
        PD_FLATTEN_TASK,

        async (
          root,
          node
        ) =>
          await flattenContainer(
            root,
            node
          ),

        stats
      );


    if (tx.accepted) {
      let moved =
        0;

      let removed =
        0;

      let shells =
        0;


      if (
        Array.isArray(
          tx.results
        )
      ) {
        for (
          const result of
          tx.results
        ) {
          moved +=
            result.moved || 0;

          removed +=
            result.removed || 0;

          shells +=
            result.shells || 0;
        }
      }


      stats.flattenedContainers +=
        tasks.length;

      stats.removedContainers +=
        removed;

      stats.movedLayers +=
        moved;

      stats.visualShells +=
        shells;

      stats.fastFlatten +=
        tasks.filter(
          task =>
            task.fast
        ).length;


      for (
        const task of tasks
      ) {
        addReport(
          stats,
          "Flatten",
          "SUCCESS",
          null,
          `${task.type} "${task.name}" · Depth ${task.depth}`
        );
      }

    } else {
      stats.flattenRejected +=
        tasks.length;

      stats.preservedAreas +=
        tasks.length;


      for (
        const task of tasks
      ) {
        const node =
          findByPluginData(
            state.root,
            PD_FLATTEN_TASK,
            task.marker
          );


        if (node) {
          setPD(
            node,
            PD_SKIP_FLATTEN,
            "1"
          );
        }


        addReport(
          stats,
          "Flatten",
          "REJECTED",
          node,
          `Depth batch rollback · ${tx.reason}`
        );
      }
    }
  }
}


/* =========================================================
   ROOT → FRAME
========================================================= */

async function convertRootToFrame(root) {
  const originalName =
    safeName(root);


  if (
    safeType(root) ===
      "FRAME"
  ) {
    return {
      root,
      changed: false
    };
  }


  if (
    safeType(root) ===
      "INSTANCE"
  ) {
    try {
      const detached =
        root.detachInstance();


      if (
        detached &&
        isAlive(detached)
      ) {
        root =
          detached;

        root.name =
          originalName;
      }
    } catch (_) {
      return {
        root,
        changed: false
      };
    }
  }


  if (
    safeType(root) ===
      "FRAME"
  ) {
    return {
      root,
      changed: true
    };
  }


  const parent =
    safeParent(root);


  if (
    !parent ||
    safeType(parent) !==
      "PAGE"
  ) {
    return {
      root,
      changed: false
    };
  }


  const index =
    parent.children.indexOf(
      root
    );


  const transform =
    safeTransform(root);


  if (
    index < 0 ||
    !transform
  ) {
    return {
      root,
      changed: false
    };
  }


  const children =
    childrenOf(root);


  const snapshots =
    children.map(
      child => ({
        child,
        transform:
          safeTransform(child)
      })
    );


  if (
    snapshots.some(
      item =>
        !item.transform
    )
  ) {
    return {
      root,
      changed: false
    };
  }


  const frame =
    figma.createFrame();


  frame.name =
    originalName;


  frame.resize(
    Math.max(
      root.width,
      0.01
    ),
    Math.max(
      root.height,
      0.01
    )
  );


  parent.insertChild(
    index,
    frame
  );


  frame.relativeTransform =
    absoluteToRelative(
      transform,
      parent
    );


  try {
    if (
      root.fills !==
        figma.mixed
    ) {
      frame.fills =
        root.fills;
    }
  } catch (_) {}


  try {
    if (
      root.strokes !==
        figma.mixed
    ) {
      frame.strokes =
        root.strokes;
    }
  } catch (_) {}


  try {
    frame.effects =
      root.effects;
  } catch (_) {}


  try {
    frame.opacity =
      root.opacity;
  } catch (_) {}


  try {
    frame.blendMode =
      root.blendMode;
  } catch (_) {}


  try {
    if (
      "clipsContent" in root
    ) {
      frame.clipsContent =
        root.clipsContent;
    }
  } catch (_) {}


  for (
    const item of snapshots
  ) {
    frame.appendChild(
      item.child
    );


    item.child.relativeTransform =
      absoluteToRelative(
        item.transform,
        frame
      );
  }


  safeRemove(root);


  return {
    root:
      frame,

    changed:
      true
  };
}


async function processRootConversion(
  state,
  stats
) {
  if (
    safeType(state.root) ===
      "FRAME"
  ) {
    return;
  }


  const tx =
    await runSingleVisualTransaction(
      state,

      async root =>
        await convertRootToFrame(
          root
        ),

      stats
    );


  if (tx.accepted) {
    stats.rootConverted++;


    addReport(
      stats,
      "Root → Frame",
      "SUCCESS",
      state.root,
      "Root name preserved"
    );

  } else {
    stats.rootConversionRejected++;


    addReport(
      stats,
      "Root → Frame",
      "REJECTED",
      state.root,
      tx.reason
    );
  }
}


/* =========================================================
   INTER
========================================================= */

const loadedInterStyles =
  new Set();


function mapInterStyle(sourceStyle) {
  const value =
    String(
      sourceStyle ||
      ""
    )
      .toLowerCase()
      .replace(
        /[_-]/g,
        " "
      )
      .replace(
        /\s+/g,
        " "
      )
      .trim();


  const italic =
    value.includes("italic") ||
    value.includes("oblique");


  let style =
    "Regular";


  if (
    value.includes("black") ||
    value.includes("heavy")
  ) {
    style =
      "Black";

  } else if (
    value.includes("extra bold") ||
    value.includes("extrabold")
  ) {
    style =
      "Extra Bold";

  } else if (
    value.includes("semi bold") ||
    value.includes("semibold")
  ) {
    style =
      "Semi Bold";

  } else if (
    value.includes("bold")
  ) {
    style =
      "Bold";

  } else if (
    value.includes("medium")
  ) {
    style =
      "Medium";

  } else if (
    value.includes("extra light") ||
    value.includes("extralight")
  ) {
    style =
      "Extra Light";

  } else if (
    value.includes("light")
  ) {
    style =
      "Light";

  } else if (
    value.includes("thin")
  ) {
    style =
      "Thin";
  }


  if (italic) {
    return (
      style === "Regular"
        ? "Italic"
        : `${style} Italic`
    );
  }


  return style;
}


async function loadInterStyle(style) {
  const wanted =
    style || "Regular";


  if (
    loadedInterStyles.has(
      wanted
    )
  ) {
    return wanted;
  }


  try {
    await figma.loadFontAsync({
      family:
        "Inter",

      style:
        wanted
    });


    loadedInterStyles.add(
      wanted
    );


    return wanted;

  } catch (_) {}


  try {
    await figma.loadFontAsync({
      family:
        "Inter",

      style:
        "Regular"
    });


    loadedInterStyles.add(
      "Regular"
    );


    return "Regular";

  } catch (_) {
    return null;
  }
}


function isInterFontName(fontName) {
  return !!(
    fontName &&
    fontName !== figma.mixed &&
    fontName.family === "Inter"
  );
}


async function convertTextNodeToInter(node) {
  let segments;


  try {
    segments =
      node.getStyledTextSegments(
        ["fontName"]
      );
  } catch (_) {
    return {
      changed: false,
      converted: 0,
      failed: 1
    };
  }


  let converted =
    0;

  let failed =
    0;


  for (
    const segment of segments
  ) {
    if (
      isInterFontName(
        segment.fontName
      )
    ) {
      continue;
    }


    if (
      segment.fontName &&
      segment.fontName !==
        figma.mixed
    ) {
      await loadFontOnce(
        segment.fontName
      );
    }


    const sourceStyle =
      segment.fontName &&
      segment.fontName !==
        figma.mixed
        ? segment.fontName.style
        : "Regular";


    const style =
      await loadInterStyle(
        mapInterStyle(
          sourceStyle
        )
      );


    if (!style) {
      failed++;
      continue;
    }


    try {
      node.setRangeFontName(
        segment.start,
        segment.end,
        {
          family:
            "Inter",

          style
        }
      );


      converted++;

    } catch (_) {
      failed++;
    }
  }


  return {
    changed:
      converted > 0,

    converted,
    failed
  };
}


async function processInterPhase(
  state,
  stats
) {
  if (!convertFontToInter) {
    return;
  }


  stats.treeScans++;


  const texts =
    [];


  function walk(node) {
    if (!isAlive(node)) {
      return;
    }


    if (
      safeType(node) ===
        "TEXT"
    ) {
      texts.push(node);
    }


    for (
      const child of
      childrenOf(node)
    ) {
      walk(child);
    }
  }


  walk(
    state.root
  );


  for (
    const text of texts
  ) {
    const result =
      await convertTextNodeToInter(
        text
      );


    if (result.changed) {
      stats.convertedTexts++;

      stats.convertedFontSegments +=
        result.converted;
    }


    if (
      result.failed > 0
    ) {
      stats.failedFontConversions++;
    }
  }
}


/* =========================================================
   NAMING
========================================================= */

function looksLikeIcon(node) {
  const value =
    safeName(node)
      .toLowerCase();


  return (
    value === "icon" ||
    value.startsWith("icon/") ||
    value.startsWith("ic_") ||
    [
      "VECTOR",
      "BOOLEAN_OPERATION",
      "POLYGON",
      "STAR"
    ].includes(
      safeType(node)
    )
  );
}


function looksLikeLine(node) {
  if (
    safeType(node) ===
      "LINE"
  ) {
    return true;
  }


  try {
    return (
      (
        node.width >= 8 &&
        node.height <= 2
      ) ||
      (
        node.height >= 8 &&
        node.width <= 2
      )
    );
  } catch (_) {
    return false;
  }
}


function looksLikeScreenshot(
  node,
  root
) {
  if (
    safeType(node) !==
      "RECTANGLE" ||
    !hasImageFill(node)
  ) {
    return false;
  }


  try {
    return (
      node.width /
        root.width >=
        0.7 &&

      node.height /
        root.height >=
        0.5
    );
  } catch (_) {
    return false;
  }
}


function looksLikeIPhone(node) {
  const value =
    safeName(node)
      .toLowerCase();


  return (
    value.includes("iphone") ||
    value.includes("i phone")
  );
}


function getContainerLayerName(node) {
  if (
    safeType(node) ===
      "FRAME" &&
    isAutoLayout(node)
  ) {
    return (
      "auto layout"
    );
  }


  if (
    safeType(node) ===
      "FRAME" &&
    looksLikeIPhone(node)
  ) {
    return (
      "iphone"
    );
  }


  if (
    safeType(node) ===
      "FRAME"
  ) {
    return (
      "frame"
    );
  }


  if (
    safeType(node) ===
      "GROUP"
  ) {
    return (
      "group"
    );
  }


  return null;
}


function desiredLayerName(
  node,
  root
) {
  const type =
    safeType(node);

  const current =
    safeName(node);


  if (
    node === root
  ) {
    return current;
  }


  if (
    isLidName(current)
  ) {
    return current;
  }


  if (
    type === "TEXT"
  ) {
    return (
      renameTextToHyphen
        ? "-"
        : current
    );
  }


  if (
    type === "RECTANGLE" &&
    hasImageFill(node)
  ) {
    return (
      looksLikeScreenshot(
        node,
        root
      )
        ? "screenshot"
        : "image"
    );
  }


  if (
    looksLikeLine(node)
  ) {
    return (
      "line"
    );
  }


  if (
    looksLikeIcon(node)
  ) {
    return (
      "icon"
    );
  }


  if (
    isShapeNode(node)
  ) {
    return (
      "shape"
    );
  }


  if (
    type === "FRAME" ||
    type === "GROUP"
  ) {
    if (
      !renameContainers
    ) {
      return current;
    }


    return (
      getContainerLayerName(
        node
      ) ||
      current
    );
  }


  if (
    type === "COMPONENT"
  ) {
    return (
      "component"
    );
  }


  if (
    type === "INSTANCE"
  ) {
    return (
      "instance"
    );
  }


  return null;
}


function processNaming(
  root,
  stats
) {
  function walk(node) {
    if (!isAlive(node)) {
      return;
    }


    if (
      node !== root
    ) {
      const wanted =
        desiredLayerName(
          node,
          root
        );


      if (
        wanted !== null &&
        wanted !== safeName(node)
      ) {
        try {
          node.name =
            wanted;

          stats.renamedLayers++;

        } catch (_) {
          stats.renameSkipped++;
        }
      }
    }


    for (
      const child of
      childrenOf(node)
    ) {
      walk(child);
    }
  }


  walk(root);
}


/* =========================================================
   ORDER
========================================================= */

function boundsOverlap(
  a,
  b
) {
  return !!(
    a &&
    b &&
    !(
      a.x + a.width <= b.x ||
      b.x + b.width <= a.x ||
      a.y + a.height <= b.y ||
      b.y + b.height <= a.y
    )
  );
}


function buildSafeDesiredPanelOrder(root) {
  const children =
    childrenOf(root);


  const panel =
    [...children]
      .reverse();


  const items =
    panel.map(
      (
        node,
        index
      ) => ({
        node,

        box:
          safeBounds(node),

        original:
          index
      })
    );


  const desired =
    [...items]
      .sort(
        (
          a,
          b
        ) => {
          if (
            !a.box ||
            !b.box
          ) {
            return (
              a.original -
              b.original
            );
          }


          const dy =
            a.box.y -
            b.box.y;


          if (
            Math.abs(dy) >
            ROW_Y_TOLERANCE
          ) {
            return dy;
          }


          return (
            a.box.x -
            b.box.x
          );
        }
      );


  /*
   * 겹치는 Layer는 기존 Z-order 유지.
   */

  for (
    let i = 0;
    i < desired.length;
    i++
  ) {
    for (
      let j =
        i + 1;
      j < desired.length;
      j++
    ) {
      if (
        boundsOverlap(
          desired[i].box,
          desired[j].box
        )
      ) {
        const a =
          desired[i];

        const b =
          desired[j];


        if (
          a.original >
          b.original
        ) {
          desired[i] =
            b;

          desired[j] =
            a;
        }
      }
    }
  }


  return desired;
}


async function reorderRootLayers(root) {
  if (
    isAutoLayout(root)
  ) {
    return {
      root,
      changed: false
    };
  }


  const current =
    childrenOf(root);


  if (
    current.length <= 1
  ) {
    return {
      root,
      changed: false
    };
  }


  const panel =
    buildSafeDesiredPanelOrder(
      root
    );


  const desired =
    panel
      .map(
        item =>
          item.node
      )
      .reverse();


  const changed =
    current.some(
      (
        node,
        index
      ) =>
        node !==
        desired[index]
    );


  if (!changed) {
    return {
      root,
      changed: false
    };
  }


  for (
    let i = 0;
    i < desired.length;
    i++
  ) {
    root.insertChild(
      i,
      desired[i]
    );
  }


  return {
    root,
    changed: true
  };
}


async function processOrderPhase(
  state,
  stats
) {
  const tx =
    await runSingleVisualTransaction(
      state,

      async root =>
        await reorderRootLayers(
          root
        ),

      stats
    );


  if (
    tx.accepted &&
    tx.changed
  ) {
    stats.orderChanged++;

  } else if (
    !tx.accepted
  ) {
    stats.orderRejected++;


    addReport(
      stats,
      "Layer Order",
      "REJECTED",
      state.root,
      tx.reason
    );
  }
}


/* =========================================================
   ANALYSIS
========================================================= */

function countAllLayers(root) {
  let count =
    0;


  function walk(node) {
    for (
      const child of
      childrenOf(node)
    ) {
      count++;

      walk(child);
    }
  }


  walk(root);

  return count;
}


function analyzeScreen(root) {
  const garbageItems =
    collectGarbageItems(
      root
    );


  const result = {
    total:
      1 +
      countAllLayers(root),

    garbage:
      garbageItems.length,

    garbageItems,

    containers: 0,
    instances: 0,
    autoLayouts: 0,
    masks: 0,
    clips: 0,
    text: 0,
    nonInterText: 0,
    icons: 0,
    lines: 0,
    bakeCandidates: 0
  };


  function walk(node) {
    if (!isAlive(node)) {
      return;
    }


    if (
      node !== root &&
      isContainer(node)
    ) {
      result.containers++;
    }


    if (
      safeType(node) ===
        "INSTANCE"
    ) {
      result.instances++;
    }


    if (
      isAutoLayout(node)
    ) {
      result.autoLayouts++;
    }


    if (
      isMaskNode(node)
    ) {
      result.masks++;
    }


    if (
      actuallyClipsChildren(node)
    ) {
      result.clips++;
    }


    if (
      safeType(node) ===
        "TEXT"
    ) {
      result.text++;


      try {
        const segments =
          node.getStyledTextSegments(
            ["fontName"]
          );


        if (
          segments.some(
            segment =>
              !isInterFontName(
                segment.fontName
              )
          )
        ) {
          result.nonInterText++;
        }

      } catch (_) {
        result.nonInterText++;
      }
    }


    if (
      looksLikeIcon(node)
    ) {
      result.icons++;
    }


    if (
      looksLikeLine(node)
    ) {
      result.lines++;
    }


    for (
      const child of
      childrenOf(node)
    ) {
      walk(child);
    }
  }


  walk(root);


  result.bakeCandidates =
    result.masks +
    result.clips;


  return result;
}


/* =========================================================
   COMMIT
========================================================= */

function commitWorkingRoot(
  original,
  working
) {
  if (
    !isAlive(original) ||
    !isAlive(working)
  ) {
    return null;
  }


  const parent =
    safeParent(original);


  if (
    !parent ||
    safeType(parent) !==
      "PAGE"
  ) {
    return null;
  }


  const index =
    parent.children.indexOf(
      original
    );


  if (
    index < 0
  ) {
    return null;
  }


  working.x =
    original.x;

  working.y =
    original.y;


  try {
    working.name =
      original.name;
  } catch (_) {}


  parent.insertChild(
    index,
    working
  );


  safeRemove(
    original
  );


  return working;
}


/* =========================================================
   PROCESS ROOT
========================================================= */

async function processRoot(
  originalRoot
) {
  const stats =
    createStats();


  const originalScreenName =
    safeName(
      originalRoot
    );


  let state;


  try {
    state =
      await createWorkingState(
        originalRoot
      );


    state.root.name =
      originalScreenName;


    /* -----------------------------------------------
       1. Garbage
    ----------------------------------------------- */

    markSelectedGarbage(
      originalRoot,
      state.root
    );


    await processGarbage(
      state,
      stats
    );


    /* -----------------------------------------------
       2. Root
    ----------------------------------------------- */

    await processRootConversion(
      state,
      stats
    );


    state.root.name =
      originalScreenName;


    /* -----------------------------------------------
       3. Instance Depth Batch
    ----------------------------------------------- */

    await processInstancePhase(
      state,
      stats
    );


    /* -----------------------------------------------
       4. Screenshot Depth Batch
    ----------------------------------------------- */

    await processScreenshotPhase(
      state,
      stats
    );


    /* -----------------------------------------------
       5. Flatten Depth Batch
    ----------------------------------------------- */

    await processFlattenPhase(
      state,
      stats
    );


    /* -----------------------------------------------
       6. Inter
    ----------------------------------------------- */

    await processInterPhase(
      state,
      stats
    );


    /* -----------------------------------------------
       7. Naming
    ----------------------------------------------- */

    processNaming(
      state.root,
      stats
    );


    state.root.name =
      originalScreenName;


    /* -----------------------------------------------
       8. Order
    ----------------------------------------------- */

    await processOrderPhase(
      state,
      stats
    );


    state.root.name =
      originalScreenName;


    /* -----------------------------------------------
       9. Plugin data cleanup
    ----------------------------------------------- */

    clearInternalPluginData(
      state.root
    );


    /* -----------------------------------------------
       10. Commit
    ----------------------------------------------- */

    const committed =
      commitWorkingRoot(
        originalRoot,
        state.root
      );


    if (!committed) {
      throw new Error(
        "Final commit failed."
      );
    }


    committed.name =
      originalScreenName;


    stats.finalLayers =
      childrenOf(
        committed
      ).length;


    return {
      success: true,
      root:
        committed,
      stats,
      fatalReason:
        null
    };


  } catch (error) {
    if (
      state &&
      state.root &&
      isAlive(state.root)
    ) {
      safeRemove(
        state.root
      );
    }


    return {
      success: false,

      root:
        originalRoot,

      stats,

      fatalReason:
        error &&
        error.message
          ? error.message
          : String(error)
    };
  }
}


/* =========================================================
   ANALYZED ROOTS
========================================================= */

async function getAnalyzedRoots() {
  const roots =
    [];


  for (
    const id of
    analyzedRootIds
  ) {
    try {
      const node =
        await figma.getNodeByIdAsync(
          id
        );


      if (
        node &&
        isAlive(node) &&
        isSupportedRoot(node)
      ) {
        roots.push(node);
      }

    } catch (_) {}
  }


  return roots;
}


/* =========================================================
   UI MESSAGE
========================================================= */

figma.ui.onmessage =
async msg => {


  /* =====================================================
     CLOSE
  ===================================================== */

  if (
    msg.type === "close"
  ) {
    figma.closePlugin();

    return;
  }


  /* =====================================================
     VIEW LAYER
  ===================================================== */

  if (
    msg.type === "select-layer"
  ) {
    try {
      const node =
        await figma.getNodeByIdAsync(
          msg.nodeId
        );


      if (
        node &&
        node.type !== "PAGE" &&
        node.type !== "DOCUMENT"
      ) {
        figma.currentPage.selection =
          [node];


        figma.viewport.scrollAndZoomIntoView(
          [node]
        );
      }

    } catch (_) {}


    return;
  }


  /* =====================================================
     ANALYZE
  ===================================================== */

  if (
    msg.type === "analyze"
  ) {
    const selection =
      [
        ...figma.currentPage.selection
      ]
        .filter(
          isAlive
        );


    if (
      selection.length === 0
    ) {
      figma.ui.postMessage({
        type:
          "error",

        message:
          "정리할 Screen을 선택해주세요."
      });

      return;
    }


    if (
      !selection.every(
        isSupportedRoot
      )
    ) {
      figma.ui.postMessage({
        type:
          "error",

        message:
`지원 타입
• Frame
• Group
• Component
• Instance`
      });

      return;
    }


    analyzedRootIds =
      selection
        .map(
          safeId
        )
        .filter(
          Boolean
        );


    const results =
      selection.map(
        root => ({
          name:
            safeName(root),

          rootType:
            safeType(root),

          willConvertToFrame:
            safeType(root) !==
              "FRAME",

          ...analyzeScreen(
            root
          )
        })
      );


    figma.ui.postMessage({
      type:
        "analysis",

      results
    });


    return;
  }


  /* =====================================================
     CLEAN
  ===================================================== */

  if (
    msg.type === "clean"
  ) {
    approvedGarbageIds =
      new Set(
        msg.garbageIds ||
        []
      );


    renameTextToHyphen =
      msg.renameTextToHyphen ===
      true;


    convertFontToInter =
      msg.convertFontToInter ===
      true;


    renameContainers =
      msg.renameContainers ===
      true;


    const roots =
      await getAnalyzedRoots();


    if (
      roots.length === 0
    ) {
      figma.ui.postMessage({
        type:
          "error",

        message:
          "Analyze했던 Screen을 찾을 수 없습니다. 다시 Analyze 해주세요."
      });

      return;
    }


    figma.ui.postMessage({
      type:
        "processing"
    });


    const resultRoots =
      [];


    const total = {
      screens:
        roots.length,

      committed: 0,
      rolledBack: 0,

      detachedInstances: 0,
      rejectedInstances: 0,

      removedGarbage: 0,
      protectedGarbage: 0,

      removedContainers: 0,
      movedLayers: 0,

      flattenedContainers: 0,
      flattenRejected: 0,

      fastGarbage: 0,
      fastFlatten: 0,

      screenshotBaked: 0,
      screenshotRejected: 0,

      rootConverted: 0,
      rootConversionRejected: 0,

      convertedTexts: 0,
      convertedFontSegments: 0,
      failedFontConversions: 0,

      renamedLayers: 0,
      renameSkipped: 0,

      orderChanged: 0,
      orderRejected: 0,

      preservedAreas: 0,

      visualShells: 0,
      bakedAreas: 0,

      finalLayers: 0,

      treeScans: 0,
      visualBatchChecks: 0,
      batchRollbacks: 0,

      report: [],

      failureReasons: []
    };


    for (
      const root of roots
    ) {
      const originalName =
        safeName(root);


      const result =
        await processRoot(
          root
        );


      if (
        result.success
      ) {
        total.committed++;

      } else {
        total.rolledBack++;


        total.failureReasons.push({
          screen:
            originalName,

          reason:
            result.fatalReason ||
            "Unknown fatal error"
        });
      }


      if (
        result.root &&
        isAlive(result.root)
      ) {
        resultRoots.push(
          result.root
        );
      }


      for (
        const key of
        Object.keys(
          result.stats
        )
      ) {
        if (
          key === "report"
        ) {
          total.report.push(
            ...result.stats.report
          );

          continue;
        }


        if (
          key in total &&
          typeof total[key] ===
            "number"
        ) {
          total[key] +=
            result.stats[key];
        }
      }
    }


    const aliveRoots =
      resultRoots.filter(
        isAlive
      );


    if (
      aliveRoots.length
    ) {
      figma.currentPage.selection =
        aliveRoots;


      figma.viewport.scrollAndZoomIntoView(
        aliveRoots
      );


      analyzedRootIds =
        aliveRoots
          .map(
            safeId
          )
          .filter(
            Boolean
          );
    }


    figma.ui.postMessage({
      type:
        "complete",

      result:
        total
    });


    console.log(
      "======================================"
    );


    console.log(
      "SCREEN LAYER CLEANER RESULT"
    );


    console.log(
      "======================================"
    );


    console.log(
      "Committed:",
      total.committed
    );


    console.log(
      "Rolled Back:",
      total.rolledBack
    );


    console.log(
      "Tree Scan:",
      total.treeScans
    );


    console.log(
      "Visual Batch Check:",
      total.visualBatchChecks
    );


    console.log(
      "Batch Rollback:",
      total.batchRollbacks
    );


    console.log(
      "Instance:",
      total.detachedInstances
    );


    console.log(
      "Flatten:",
      total.flattenedContainers
    );


    console.log(
      "Inter:",
      total.convertedTexts
    );


    try {
      console.table(
        total.report
      );
    } catch (_) {}


    if (
      total.failureReasons.length
    ) {
      console.error(
        "Fatal Errors:",
        total.failureReasons
      );
    }


    if (
      total.rolledBack === 0
    ) {
      figma.notify(
        `Cleanup 완료 · Instance ${total.detachedInstances} · Flatten ${total.flattenedContainers} · Inter ${total.convertedTexts}`
      );

    } else {
      figma.notify(
        `Cleanup 완료 · ${total.committed} 성공 / ${total.rolledBack} 실패`
      );
    }
  }
};
