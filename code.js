figma.showUI(__html__, {
  width: 440,
  height: 760,
  themeColors: true
});


/* =========================================================
   SCREEN LAYER CLEANER

   Architecture
   ---------------------------------------------------------
   1. Work on clone
   2. Structural phases are processed in batches
   3. Re-scan tree after every structural phase
   4. PNG verification once per batch
   5. Binary isolation only when a batch fails
   6. Font → Inter is an explicit visual change,
      so it is NOT rolled back by PNG verification
   7. Root Screen name is always preserved
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
const GEOMETRY_TOLERANCE = 0.25;

const MAX_INSTANCE_ROUNDS = 3;


/* =========================================================
   PLUGIN DATA

   Task type별 marker를 분리한다.

   기존에는 모든 작업이 PD_TASK_ID 하나를 공유하면서
   새로운 Plan을 만들 때 이전 marker가 덮어써질 수 있었다.
========================================================= */

const PD_GARBAGE_ID = "slc_garbage_id";

const PD_GARBAGE_TASK = "slc_garbage_task";
const PD_INSTANCE_TASK = "slc_instance_task";
const PD_SCREENSHOT_TASK = "slc_screenshot_task";
const PD_FLATTEN_TASK = "slc_flatten_task";
const PD_INTER_TASK = "slc_inter_task";

const PD_SKIP_DETACH = "slc_skip_detach";
const PD_SKIP_SCREENSHOT = "slc_skip_screenshot";
const PD_SKIP_FLATTEN = "slc_skip_flatten";


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
    binarySplits: 0,

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
    reason: reason || ""
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
    return !!(node && node.parent);
  } catch (_) {
    return false;
  }
}


function childrenOf(node) {
  try {
    if (!node || !isAlive(node)) {
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
    return node.absoluteBoundingBox || null;
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
    return node.absoluteTransform || null;
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
  const parent = safeParent(node);

  if (!parent || !isAutoLayout(parent)) {
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
   MATRIX / TRANSFORM
========================================================= */

function multiplyTransform(a, b) {
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

  if (Math.abs(det) < 0.000001) {
    throw new Error(
      "Transform matrix cannot be inverted."
    );
  }

  const inv = 1 / det;

  return [
    [
      d * inv,
      -c * inv,
      (c * f - d * e) * inv
    ],

    [
      -b * inv,
      a * inv,
      (b * e - a * f) * inv
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
    invertTransform(parentTransform),
    absoluteTransform
  );
}


/* =========================================================
   PLUGIN DATA
========================================================= */

function getPD(node, key) {
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


function findByPluginData(
  root,
  key,
  value
) {
  let found = null;

  function walk(node) {
    if (
      found ||
      !isAlive(node)
    ) {
      return;
    }

    if (
      getPD(node, key) ===
      value
    ) {
      found = node;
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

    for (const key of keys) {
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
   TASK MARKER
========================================================= */

let taskCounter = 0;

function createTaskMarker(prefix) {
  taskCounter++;

  return (
    `${prefix}_${Date.now()}_${taskCounter}`
  );
}


/* =========================================================
   ORIGINAL → WORK COPY PATH MAPPING
========================================================= */

function createPathMap(root) {
  const map = new Map();

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

  walk(root, []);

  return map;
}


function resolvePath(
  root,
  path
) {
  let current = root;

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
      format: "PNG",

      constraint: {
        type: "SCALE",
        value: 1
      }
    });

  } catch (_) {
    return null;
  }
}


function sameBytes(a, b) {
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
    if (a[i] !== b[i]) {
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
    root: clone
  };
}


/* =========================================================
   PHASE TRANSACTION

   한 Phase 안의 작업을 전부 한 번에 적용한다.

   Before PNG 1회
   ↓
   Batch Mutation
   ↓
   After PNG 1회

   실패한 Phase만 Binary Isolation.
========================================================= */

async function runVisualBatchTransaction(
  state,
  tasks,
  resolveNode,
  mutateTask,
  stats
) {
  if (
    !state ||
    !isAlive(state.root) ||
    !tasks ||
    tasks.length === 0
  ) {
    return {
      accepted: false,
      attempted: false,
      reason: "empty-batch",
      results: []
    };
  }

  stats.visualBatchChecks++;

  const currentRoot =
    state.root;

  const rootX =
    currentRoot.x;

  const rootY =
    currentRoot.y;

  const before =
    await exportNodePng(
      currentRoot
    );

  if (!before) {
    return {
      accepted: false,
      attempted: false,
      reason: "before-render-failed",
      results: []
    };
  }


  /* -----------------------------------------------------
     One checkpoint per batch
  ----------------------------------------------------- */

  let checkpoint;

  try {
    checkpoint =
      currentRoot.clone();

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
      accepted: false,
      attempted: false,
      reason: "checkpoint-create-failed",
      results: [],
      error
    };
  }


  const results = [];

  let changedAny = false;


  try {
    for (
      const task of tasks
    ) {
      let node = null;

      try {
        node =
          resolveNode(
            state.root,
            task
          );
      } catch (_) {}


      if (!node) {
        results.push({
          task,
          changed: false,
          reason: "task-node-missing"
        });

        continue;
      }


      let result;

      try {
        result =
          await mutateTask(
            state.root,
            node,
            task
          );

      } catch (error) {
        result = {
          changed: false,
          reason: "operation-error",
          error
        };
      }


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
        changedAny = true;
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

    return {
      accepted: false,
      attempted: true,
      reason: "batch-operation-error",
      results,
      error
    };
  }


  if (!changedAny) {
    safeRemove(checkpoint);

    return {
      accepted: false,
      attempted: false,
      reason: "no-change",
      results
    };
  }


  const after =
    await exportNodePng(
      state.root
    );


  if (!after) {
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

    return {
      accepted: false,
      attempted: true,
      reason: "after-render-failed",
      results
    };
  }


  if (
    sameBytes(
      before,
      after
    )
  ) {
    safeRemove(checkpoint);

    return {
      accepted: true,
      attempted: true,
      reason: "visual-identical",
      results
    };
  }


  /* -----------------------------------------------------
     Rollback whole batch
  ----------------------------------------------------- */

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

  return {
    accepted: false,
    attempted: true,
    reason: "visual-changed",
    results
  };
}


/* =========================================================
   PHASE + BINARY FALLBACK
========================================================= */

async function processBatchWithIsolation({
  state,
  tasks,
  resolveNode,
  mutateTask,
  stats,
  onAccepted,
  onRejected,
  onSkipped
}) {
  if (
    !tasks ||
    tasks.length === 0
  ) {
    return;
  }


  /*
   * 먼저 전체 Phase를 한 번에 시도.
   */

  const tx =
    await runVisualBatchTransaction(
      state,
      tasks,
      resolveNode,
      mutateTask,
      stats
    );


  if (tx.accepted) {
    const resultMap =
      new Map();

    for (
      const item of
      tx.results
    ) {
      resultMap.set(
        item.task.marker,
        item
      );
    }


    for (
      const task of tasks
    ) {
      const result =
        resultMap.get(
          task.marker
        );

      if (
        result &&
        result.changed
      ) {
        if (onAccepted) {
          await onAccepted(
            task,
            result
          );
        }

      } else {
        if (onSkipped) {
          await onSkipped(
            task,
            result || {
              reason: "no-change"
            }
          );
        }
      }
    }

    return;
  }


  /*
   * Mutation 자체가 없었던 경우.
   */

  if (!tx.attempted) {
    if (onSkipped) {
      for (
        const task of tasks
      ) {
        await onSkipped(
          task,
          {
            reason: tx.reason
          }
        );
      }
    }

    return;
  }


  /*
   * 단일 Task까지 분리했는데도 실패.
   */

  if (tasks.length === 1) {
    if (onRejected) {
      await onRejected(
        tasks[0],
        tx
      );
    }

    return;
  }


  /*
   * Phase 실패한 경우에만 Binary Isolation.
   */

  stats.binarySplits++;

  const middle =
    Math.ceil(
      tasks.length /
      2
    );


  await processBatchWithIsolation({
    state,

    tasks:
      tasks.slice(
        0,
        middle
      ),

    resolveNode,
    mutateTask,
    stats,
    onAccepted,
    onRejected,
    onSkipped
  });


  await processBatchWithIsolation({
    state,

    tasks:
      tasks.slice(
        middle
      ),

    resolveNode,
    mutateTask,
    stats,
    onAccepted,
    onRejected,
    onSkipped
  });
}


/* =========================================================
   SINGLE VERIFIED OPERATION
========================================================= */

async function runSingleVisualTransaction(
  state,
  mutate,
  stats
) {
  const task = {
    marker:
      createTaskMarker(
        "single"
      )
  };

  return await runVisualBatchTransaction(
    state,
    [task],

    () => state.root,

    async root =>
      await mutate(root),

    stats
  );
}


/* =========================================================
   LID
========================================================= */

function isLidName(name) {
  const value =
    String(name || "")
      .trim()
      .toLowerCase();

  return (
    value.startsWith("cci_ctn_") ||
    value.startsWith("cci_msg_") ||
    value.startsWith("ctn_") ||
    value.startsWith("msg_")
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
        fill =>
          fill.type === "IMAGE" &&
          fill.visible !== false
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
    try {
      if (
        "visible" in child &&
        child.visible === false
      ) {
        continue;
      }
    } catch (_) {}


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
   GARBAGE
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
  if (
    !isAlive(node) ||
    !isAlive(root) ||
    node === root
  ) {
    return false;
  }


  const nodeBox =
    safeRenderBounds(node);

  const rootBox =
    safeBounds(root);


  if (!nodeBox || !rootBox) {
    return false;
  }


  return (
    nodeBox.x +
      nodeBox.width <=
      rootBox.x ||

    nodeBox.x >=
      rootBox.x +
      rootBox.width ||

    nodeBox.y +
      nodeBox.height <=
      rootBox.y ||

    nodeBox.y >=
      rootBox.y +
      rootBox.height
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
      return "Hidden · visible=false";
    }
  } catch (_) {}


  try {
    if (
      "opacity" in node &&
      node.opacity === 0
    ) {
      return "Transparent · opacity=0";
    }
  } catch (_) {}


  if (
    safeType(node) === "SLICE"
  ) {
    return "Slice";
  }


  if (isTinyNode(node)) {
    return "Zero / Tiny Size";
  }


  if (isEmptyVisualShape(node)) {
    return "Empty Shape";
  }


  if (isEmptyContainer(node)) {
    return "Empty Container";
  }


  if (
    isOutsideRoot(
      node,
      root
    ) &&
    !isMaskNode(node)
  ) {
    return "Outside Screen";
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
      if (
        "clipsContent" in root &&
        root.clipsContent === true
      ) {
        return true;
      }
    } catch (_) {}
  }


  return false;
}


function collectGarbageItems(root) {
  const result = [];

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
      result.push({
        id:
          safeId(node) ||
          "",

        name,

        type:
          safeType(node) ||
          "UNKNOWN",

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

  return result;
}


/* =========================================================
   MARK SELECTED GARBAGE
========================================================= */

function markSelectedGarbage(
  originalRoot,
  workRoot
) {
  const pathMap =
    createPathMap(
      originalRoot
    );

  for (
    const id of
    approvedGarbageIds
  ) {
    const path =
      pathMap.get(id);

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


/* =========================================================
   BUILD GARBAGE PLAN
========================================================= */

function buildGarbagePlan(
  root,
  stats
) {
  stats.treeScans++;

  clearPluginKey(
    root,
    PD_GARBAGE_TASK
  );

  const tasks = [];


  function countMarked(node) {
    let count = 0;

    function walk(current) {
      if (!isAlive(current)) {
        return;
      }

      if (
        getPD(
          current,
          PD_GARBAGE_ID
        )
      ) {
        count++;
      }

      for (
        const child of
        childrenOf(current)
      ) {
        walk(child);
      }
    }

    walk(node);

    return Math.max(
      count,
      1
    );
  }


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

        count:
          countMarked(node),

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
   PROCESS GARBAGE
========================================================= */

async function processGarbage(
  state,
  stats
) {
  let tasks =
    buildGarbagePlan(
      state.root,
      stats
    );


  /*
   * Fast-safe garbage는 PNG 없이 일괄 삭제.
   */

  const fast =
    tasks.filter(
      task =>
        task.fast
    );


  for (
    const task of fast
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
      stats.removedGarbage +=
        task.count;

      stats.fastGarbage +=
        task.count;

      addReport(
        stats,
        "Garbage Delete",
        "SUCCESS",
        null,
        `${task.type} "${task.name}" · Fast`
      );
    }
  }


  /*
   * Tree가 바뀌었으므로 즉시 Garbage Plan 재생성.
   */

  tasks =
    buildGarbagePlan(
      state.root,
      stats
    );


  const risky =
    tasks.filter(
      task =>
        !task.fast
    );


  await processBatchWithIsolation({
    state,
    tasks: risky,

    resolveNode:
      (root, task) =>
        findByPluginData(
          root,
          PD_GARBAGE_TASK,
          task.marker
        ),

    mutateTask:
      async (
        root,
        node
      ) => ({
        root,

        changed:
          safeRemove(node),

        reason:
          "deleted"
      }),

    stats,


    onAccepted:
      async task => {
        stats.removedGarbage +=
          task.count;

        addReport(
          stats,
          "Garbage Delete",
          "SUCCESS",
          null,
          `${task.type} "${task.name}" · Batch Verified`
        );
      },


    onRejected:
      async (
        task,
        tx
      ) => {
        stats.protectedGarbage +=
          task.count;

        const restored =
          findByPluginData(
            state.root,
            PD_GARBAGE_TASK,
            task.marker
          );

        if (restored) {
          setPD(
            restored,
            PD_GARBAGE_ID,
            ""
          );
        }

        addReport(
          stats,
          "Garbage Delete",
          "REJECTED",
          restored,
          tx.reason ===
            "visual-changed"
            ? "삭제 시 Render 변경"
            : tx.reason
        );
      },


    onSkipped:
      async () => {}
  });
}


/* =========================================================
   FONT LOAD
========================================================= */

const loadedFonts =
  new Set();


async function loadFontOnce(
  fontName
) {
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


async function ensureTextFontsLoaded(node) {
  if (
    safeType(node) !== "TEXT"
  ) {
    return true;
  }


  try {
    const segments =
      node.getStyledTextSegments(
        ["fontName"]
      );

    for (
      const segment of segments
    ) {
      if (
        segment.fontName &&
        segment.fontName !== figma.mixed
      ) {
        await loadFontOnce(
          segment.fontName
        );
      }
    }

    return true;

  } catch (_) {
    return false;
  }
}


async function ensureSubtreeFontsLoaded(node) {
  if (!isAlive(node)) {
    return false;
  }


  if (
    safeType(node) === "TEXT"
  ) {
    return await ensureTextFontsLoaded(
      node
    );
  }


  for (
    const child of
    childrenOf(node)
  ) {
    await ensureSubtreeFontsLoaded(
      child
    );
  }

  return true;
}


/* =========================================================
   INSTANCE PLAN

   매 Phase마다 새로 생성.
========================================================= */

function buildInstancePlan(
  root,
  stats
) {
  stats.treeScans++;

  clearPluginKey(
    root,
    PD_INSTANCE_TASK
  );

  const tasks = [];


  function walk(
    node,
    depth
  ) {
    if (!isAlive(node)) {
      return;
    }


    if (
      node !== root &&
      safeType(node) === "INSTANCE" &&
      getPD(
        node,
        PD_SKIP_DETACH
      ) !== "1"
    ) {
      const marker =
        createTaskMarker(
          "instance"
        );

      setPD(
        node,
        PD_INSTANCE_TASK,
        marker
      );

      tasks.push({
        marker,
        depth,
        name:
          safeName(node)
      });

      /*
       * 아직 Instance 내부는 스캔하지 않는다.
       * Detach 후 새 Tree에서 다시 스캔.
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


  tasks.sort(
    (a, b) =>
      b.depth -
      a.depth
  );

  return tasks;
}


/* =========================================================
   INSTANCE PHASE
========================================================= */

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
      buildInstancePlan(
        state.root,
        stats
      );

    if (
      tasks.length === 0
    ) {
      break;
    }


    await processBatchWithIsolation({
      state,
      tasks,

      resolveNode:
        (root, task) =>
          findByPluginData(
            root,
            PD_INSTANCE_TASK,
            task.marker
          ),

      mutateTask:
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
              changed: false,
              reason:
                "not-instance"
            };
          }


          let detached;

          try {
            detached =
              node.detachInstance();
          } catch (_) {
            return {
              root,
              changed: false,
              reason:
                "detach-error"
            };
          }


          return {
            root,
            changed:
              !!detached,
            reason:
              detached
                ? "detached"
                : "detach-failed"
          };
        },

      stats,


      onAccepted:
        async task => {
          stats.detachedInstances++;

          addReport(
            stats,
            "Instance Detach",
            "SUCCESS",
            null,
            `"${task.name}" · Batch`
          );
        },


      onRejected:
        async (
          task,
          tx
        ) => {
          stats.rejectedInstances++;
          stats.preservedAreas++;

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
            tx.reason ===
              "visual-changed"
              ? "Detach 시 Render 변경"
              : tx.reason
          );
        },


      onSkipped:
        async () => {}
    });


    /*
     * 중요:
     * 기존 Instance Plan 폐기.
     *
     * 다음 round는 현재 Tree를 다시 Scan한다.
     */
  }
}


/* =========================================================
   SCREENSHOT PLAN
========================================================= */

function buildScreenshotPlan(
  root,
  stats
) {
  stats.treeScans++;

  clearPluginKey(
    root,
    PD_SCREENSHOT_TASK
  );

  const tasks = [];


  function walk(
    node,
    depth
  ) {
    if (!isAlive(node)) {
      return;
    }


    /*
     * Children 먼저 읽는다.
     */

    for (
      const child of
      childrenOf(node)
    ) {
      walk(
        child,
        depth + 1
      );
    }


    if (node === root) {
      return;
    }


    if (
      !isContainer(node)
    ) {
      return;
    }


    if (
      getPD(
        node,
        PD_SKIP_SCREENSHOT
      ) === "1"
    ) {
      return;
    }


    if (
      !containsMask(node) &&
      !actuallyClipsChildren(node)
    ) {
      return;
    }


    const marker =
      createTaskMarker(
        "screenshot"
      );

    setPD(
      node,
      PD_SCREENSHOT_TASK,
      marker
    );

    tasks.push({
      marker,
      depth,
      name:
        safeName(node)
    });
  }


  walk(
    root,
    0
  );


  tasks.sort(
    (a, b) =>
      b.depth -
      a.depth
  );

  return tasks;
}


/* =========================================================
   SCREENSHOT REPLACEMENT
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
      changed: false,
      reason: "invalid-parent"
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
      changed: false,
      reason:
        "invalid-render-bounds"
    };
  }


  const index =
    parent.children.indexOf(
      container
    );


  if (index < 0) {
    return {
      root,
      changed: false,
      reason: "index-invalid"
    };
  }


  let bytes;

  try {
    bytes =
      await container.exportAsync({
        format: "PNG",

        constraint: {
          type: "SCALE",
          value: 1
        }
      });
  } catch (_) {
    return {
      root,
      changed: false,
      reason:
        "container-export-failed"
    };
  }


  const image =
    figma.createImage(
      bytes
    );


  const rectangle =
    figma.createRectangle();

  rectangle.name =
    "screenshot";


  rectangle.resize(
    Math.max(
      bounds.width,
      0.01
    ),
    Math.max(
      bounds.height,
      0.01
    )
  );


  rectangle.fills = [
    {
      type: "IMAGE",
      scaleMode: "FILL",
      imageHash: image.hash
    }
  ];


  try {
    if (
      isAutoLayout(parent)
    ) {
      rectangle.layoutPositioning =
        "ABSOLUTE";
    }
  } catch (_) {}


  parent.insertChild(
    index,
    rectangle
  );


  rectangle.relativeTransform =
    absoluteToRelative(
      [
        [1, 0, bounds.x],
        [0, 1, bounds.y]
      ],
      parent
    );


  safeRemove(container);


  return {
    root,
    changed: true,
    reason:
      "screenshot-created"
  };
}


/* =========================================================
   SCREENSHOT PHASE
========================================================= */

async function processScreenshotPhase(
  state,
  stats
) {
  const tasks =
    buildScreenshotPlan(
      state.root,
      stats
    );


  await processBatchWithIsolation({
    state,
    tasks,

    resolveNode:
      (root, task) =>
        findByPluginData(
          root,
          PD_SCREENSHOT_TASK,
          task.marker
        ),

    mutateTask:
      async (
        root,
        node
      ) =>
        await replaceWithScreenshot(
          root,
          node
        ),

    stats,


    onAccepted:
      async task => {
        stats.screenshotBaked++;
        stats.bakedAreas++;

        addReport(
          stats,
          "Mask / Clip",
          "SUCCESS",
          null,
          `"${task.name}" → screenshot`
        );
      },


    onRejected:
      async (
        task,
        tx
      ) => {
        stats.screenshotRejected++;
        stats.preservedAreas++;

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
          "Mask / Clip",
          "REJECTED",
          node,
          tx.reason ===
            "visual-changed"
            ? "Screenshot 변환 시 Render 변경"
            : tx.reason
        );
      },


    onSkipped:
      async () => {}
  });
}


/* =========================================================
   FLATTEN
========================================================= */

function isFlattenCandidate(node) {
  const type =
    safeType(node);

  return (
    isAlive(node) &&

    [
      "FRAME",
      "GROUP",
      "COMPONENT"
    ].includes(type) &&

    !containsMask(node) &&
    !actuallyClipsChildren(node) &&

    getPD(
      node,
      PD_SKIP_FLATTEN
    ) !== "1"
  );
}


function isFastFlattenCandidate(node) {
  const type =
    safeType(node);


  if (
    !isAlive(node) ||
    ![
      "FRAME",
      "GROUP"
    ].includes(type)
  ) {
    return false;
  }


  if (
    isAutoLayout(node) ||
    participatesInAutoLayout(node) ||
    containsMask(node) ||
    actuallyClipsChildren(node) ||
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


  try {
    if (
      "rotation" in node &&
      Math.abs(
        node.rotation
      ) > 0.001
    ) {
      return false;
    }
  } catch (_) {}


  try {
    if (
      "blendMode" in node &&
      node.blendMode !==
        "PASS_THROUGH" &&
      node.blendMode !==
        "NORMAL"
    ) {
      return false;
    }
  } catch (_) {}


  return true;
}


/* =========================================================
   FLATTEN PLAN
========================================================= */

function buildFlattenPlan(
  root,
  stats
) {
  stats.treeScans++;

  clearPluginKey(
    root,
    PD_FLATTEN_TASK
  );

  const fast = [];
  const risky = [];


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


    const marker =
      createTaskMarker(
        "flatten"
      );


    setPD(
      node,
      PD_FLATTEN_TASK,
      marker
    );


    const task = {
      marker,
      depth,
      name:
        safeName(node),
      type:
        safeType(node)
    };


    if (
      isFastFlattenCandidate(node)
    ) {
      fast.push(task);
    } else {
      risky.push(task);
    }
  }


  walk(
    root,
    0
  );


  const deepFirst =
    (a, b) =>
      b.depth -
      a.depth;


  fast.sort(deepFirst);
  risky.sort(deepFirst);


  return {
    fast,
    risky
  };
}


/* =========================================================
   GEOMETRY
========================================================= */

function captureDirectChildGeometry(node) {
  const result = [];

  for (
    const child of
    childrenOf(node)
  ) {
    const box =
      safeBounds(child);

    if (!box) {
      continue;
    }

    result.push({
      node: child,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height
    });
  }

  return result;
}


function geometryMatches(snapshot) {
  for (
    const before of snapshot
  ) {
    if (
      !isAlive(before.node)
    ) {
      return false;
    }

    const after =
      safeBounds(
        before.node
      );

    if (!after) {
      return false;
    }


    if (
      Math.abs(
        before.x -
        after.x
      ) >
        GEOMETRY_TOLERANCE ||

      Math.abs(
        before.y -
        after.y
      ) >
        GEOMETRY_TOLERANCE ||

      Math.abs(
        before.width -
        after.width
      ) >
        GEOMETRY_TOLERANCE ||

      Math.abs(
        before.height -
        after.height
      ) >
        GEOMETRY_TOLERANCE
    ) {
      return false;
    }
  }

  return true;
}


/* =========================================================
   FAST FLATTEN

   Fast Flatten 실패 시 해당 Container만 local clone 복원.

   중요한 점:
   이 Phase가 끝난 뒤 Flatten Plan을 폐기하고 다시 만든다.
   따라서 clone으로 Node ID가 바뀌어도 다음 Plan에는 영향 없음.
========================================================= */

async function fastFlattenOne(
  state,
  task,
  stats
) {
  const container =
    findByPluginData(
      state.root,
      PD_FLATTEN_TASK,
      task.marker
    );


  if (
    !container ||
    !isFastFlattenCandidate(
      container
    )
  ) {
    return false;
  }


  const parent =
    safeParent(container);


  if (
    !parent ||
    !("children" in parent)
  ) {
    return false;
  }


  const index =
    parent.children.indexOf(
      container
    );


  if (index < 0) {
    return false;
  }


  const children =
    childrenOf(container);


  if (
    children.length === 0
  ) {
    if (
      safeRemove(container)
    ) {
      stats.fastFlatten++;
      stats.flattenedContainers++;
      stats.removedContainers++;

      return true;
    }

    return false;
  }


  await ensureSubtreeFontsLoaded(
    container
  );


  const geometry =
    captureDirectChildGeometry(
      container
    );


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
    return false;
  }


  const originalRelativeTransform =
    container.relativeTransform;


  const backup =
    container.clone();


  figma.currentPage.appendChild(
    backup
  );


  backup.x =
    container.absoluteBoundingBox
      ? container.absoluteBoundingBox.x +
        CHECKPOINT_OFFSET_X
      : backup.x +
        CHECKPOINT_OFFSET_X;


  const moved = [];


  try {
    let insertion =
      index;


    for (
      const item of snapshots
    ) {
      parent.insertChild(
        insertion,
        item.child
      );


      item.child.relativeTransform =
        absoluteToRelative(
          item.transform,
          parent
        );


      moved.push(
        item.child
      );

      insertion++;
    }


    safeRemove(container);


    if (
      !geometryMatches(
        geometry
      )
    ) {
      throw new Error(
        "geometry-changed"
      );
    }


    safeRemove(backup);


    stats.fastFlatten++;
    stats.flattenedContainers++;
    stats.removedContainers++;
    stats.movedLayers +=
      moved.length;


    return true;

  } catch (_) {

    /*
     * 실패한 container만 local rollback.
     */

    for (
      const child of moved
    ) {
      if (isAlive(child)) {
        safeRemove(child);
      }
    }


    if (isAlive(backup)) {
      parent.insertChild(
        index,
        backup
      );

      try {
        backup.relativeTransform =
          originalRelativeTransform;
      } catch (_) {}
    }


    return false;
  }
}


/* =========================================================
   VISUAL SHELL
========================================================= */

function createVisualShell(
  source,
  parent,
  index
) {
  if (
    !isAlive(source) ||
    !isAlive(parent)
  ) {
    return null;
  }


  const transform =
    safeTransform(source);

  if (!transform) {
    return null;
  }


  const rectangle =
    figma.createRectangle();

  rectangle.name =
    "shape";


  try {
    rectangle.resize(
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
      rectangle.remove();
    } catch (_) {}

    return null;
  }


  try {
    if (
      source.fills !==
      figma.mixed
    ) {
      rectangle.fills =
        source.fills;
    }
  } catch (_) {}


  try {
    if (
      source.strokes !==
      figma.mixed
    ) {
      rectangle.strokes =
        source.strokes;
    }
  } catch (_) {}


  try {
    rectangle.strokeWeight =
      source.strokeWeight;

    rectangle.strokeAlign =
      source.strokeAlign;
  } catch (_) {}


  try {
    if (
      "dashPattern" in source
    ) {
      rectangle.dashPattern =
        source.dashPattern;
    }
  } catch (_) {}


  try {
    if (
      "strokeCap" in source
    ) {
      rectangle.strokeCap =
        source.strokeCap;
    }
  } catch (_) {}


  try {
    if (
      "strokeJoin" in source
    ) {
      rectangle.strokeJoin =
        source.strokeJoin;
    }
  } catch (_) {}


  try {
    rectangle.effects =
      source.effects;
  } catch (_) {}


  try {
    rectangle.opacity =
      source.opacity;
  } catch (_) {}


  try {
    rectangle.blendMode =
      source.blendMode;
  } catch (_) {}


  try {
    rectangle.topLeftRadius =
      source.topLeftRadius;

    rectangle.topRightRadius =
      source.topRightRadius;

    rectangle.bottomLeftRadius =
      source.bottomLeftRadius;

    rectangle.bottomRightRadius =
      source.bottomRightRadius;
  } catch (_) {}


  try {
    if (
      isAutoLayout(parent)
    ) {
      rectangle.layoutPositioning =
        "ABSOLUTE";
    }
  } catch (_) {}


  try {
    parent.insertChild(
      index,
      rectangle
    );


    rectangle.relativeTransform =
      absoluteToRelative(
        transform,
        parent
      );


    return rectangle;

  } catch (_) {
    try {
      rectangle.remove();
    } catch (_) {}

    return null;
  }
}


/* =========================================================
   NORMAL FLATTEN
========================================================= */

async function flattenContainerOneLevel(
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
      changed: false,
      reason: "invalid-parent"
    };
  }


  const index =
    parent.children.indexOf(
      container
    );


  if (index < 0) {
    return {
      root,
      changed: false,
      reason: "index-invalid"
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
        safeRemove(
          container
        ),

      reason:
        "empty-container",

      moved: 0,
      removed: 1,
      shells: 0
    };
  }


  await ensureSubtreeFontsLoaded(
    container
  );


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
      changed: false,
      reason:
        "transform-unavailable"
    };
  }


  let insertion =
    index;

  let shells = 0;


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
      insertion++;
      shells++;
    }
  }


  let moved = 0;


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


    insertion++;
    moved++;
  }


  safeRemove(container);


  return {
    root,
    changed: true,
    reason: "flattened",
    moved,
    removed: 1,
    shells
  };
}


/* =========================================================
   FLATTEN PHASE

   1. Fast candidates
   2. Tree changed → throw away Plan
   3. Re-scan
   4. Risky candidates batch verify
========================================================= */

async function processFlattenPhase(
  state,
  stats
) {
  let plan =
    buildFlattenPlan(
      state.root,
      stats
    );


  /*
   * FAST
   */

  for (
    const task of
    plan.fast
  ) {
    const success =
      await fastFlattenOne(
        state,
        task,
        stats
      );

    if (success) {
      addReport(
        stats,
        "Container Flatten",
        "SUCCESS",
        null,
        `${task.type} "${task.name}" · Fast Geometry`
      );
    }
  }


  /*
   * Fast Flatten이 Tree를 변경했으므로
   * 이전 Plan을 완전히 폐기한다.
   */

  plan =
    buildFlattenPlan(
      state.root,
      stats
    );


  /*
   * 새 Plan의 Risky + Fast 잔여분.
   *
   * Fast 실패 후보도 새 Plan에서 다시 계산되므로
   * stale marker를 사용하지 않는다.
   */

  const riskyTasks = [
    ...plan.fast,
    ...plan.risky
  ];


  riskyTasks.sort(
    (a, b) =>
      b.depth -
      a.depth
  );


  await processBatchWithIsolation({
    state,
    tasks:
      riskyTasks,

    resolveNode:
      (root, task) =>
        findByPluginData(
          root,
          PD_FLATTEN_TASK,
          task.marker
        ),

    mutateTask:
      async (
        root,
        node
      ) =>
        await flattenContainerOneLevel(
          root,
          node
        ),

    stats,


    onAccepted:
      async (
        task,
        result
      ) => {
        stats.flattenedContainers++;

        stats.removedContainers +=
          result.removed || 0;

        stats.movedLayers +=
          result.moved || 0;

        stats.visualShells +=
          result.shells || 0;

        addReport(
          stats,
          "Container Flatten",
          "SUCCESS",
          null,
          `${task.type} "${task.name}" · Batch Verified`
        );
      },


    onRejected:
      async (
        task,
        tx
      ) => {
        stats.flattenRejected++;
        stats.preservedAreas++;

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
          "Container Flatten",
          "REJECTED",
          node,
          tx.reason ===
            "visual-changed"
            ? "Flatten 시 Render 변경"
            : tx.reason
        );
      },


    onSkipped:
      async () => {}
  });
}


/* =========================================================
   ROOT → FRAME
========================================================= */

async function convertRootToFrame(root) {
  const originalRootName =
    safeName(root);


  if (
    safeType(root) === "FRAME"
  ) {
    return {
      root,
      changed: false,
      reason:
        "already-frame"
    };
  }


  /*
   * Root Instance
   */

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
        root = detached;

        try {
          root.name =
            originalRootName;
        } catch (_) {}
      }

    } catch (_) {
      return {
        root,
        changed: false,
        reason:
          "root-instance-detach-failed"
      };
    }
  }


  if (
    safeType(root) === "FRAME"
  ) {
    try {
      root.name =
        originalRootName;
    } catch (_) {}

    return {
      root,
      changed: true,
      reason:
        "root-instance-detached"
    };
  }


  const parent =
    safeParent(root);


  if (
    !parent ||
    safeType(parent) !== "PAGE"
  ) {
    return {
      root,
      changed: false,
      reason:
        "root-not-page-child"
    };
  }


  const index =
    parent.children.indexOf(
      root
    );


  if (index < 0) {
    return {
      root,
      changed: false,
      reason:
        "root-index-invalid"
    };
  }


  const transform =
    safeTransform(root);


  if (!transform) {
    return {
      root,
      changed: false,
      reason:
        "root-transform-unavailable"
    };
  }


  await ensureSubtreeFontsLoaded(
    root
  );


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
      changed: false,
      reason:
        "child-transform-unavailable"
    };
  }


  const frame =
    figma.createFrame();


  frame.name =
    originalRootName;

  frame.fills = [];
  frame.clipsContent = false;


  try {
    frame.layoutMode =
      "NONE";
  } catch (_) {}


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


  /*
   * Copy visual properties
   */

  try {
    if (
      "fills" in root &&
      root.fills !== figma.mixed
    ) {
      frame.fills =
        root.fills;
    }
  } catch (_) {}


  try {
    if (
      "strokes" in root &&
      root.strokes !== figma.mixed
    ) {
      frame.strokes =
        root.strokes;
    }
  } catch (_) {}


  try {
    frame.strokeWeight =
      root.strokeWeight;

    frame.strokeAlign =
      root.strokeAlign;
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
    root: frame,
    changed: true,
    reason:
      "converted-to-frame"
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

  } else if (tx.attempted) {
    stats.rootConversionRejected++;
    stats.preservedAreas++;

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
   FONT → INTER

   사용자가 직접 요청한 visual change.
   PNG Rollback 대상 아님.
========================================================= */

const loadedInterStyles =
  new Set();


function mapInterStyle(sourceStyle) {
  const value =
    String(
      sourceStyle || ""
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
    style = "Black";

  } else if (
    value.includes("extra bold") ||
    value.includes("extrabold") ||
    value.includes("ultra bold") ||
    value.includes("ultrabold")
  ) {
    style = "Extra Bold";

  } else if (
    value.includes("semi bold") ||
    value.includes("semibold") ||
    value.includes("demi bold") ||
    value.includes("demibold")
  ) {
    style = "Semi Bold";

  } else if (
    value.includes("bold")
  ) {
    style = "Bold";

  } else if (
    value.includes("medium")
  ) {
    style = "Medium";

  } else if (
    value.includes("extra light") ||
    value.includes("extralight") ||
    value.includes("ultra light") ||
    value.includes("ultralight")
  ) {
    style = "Extra Light";

  } else if (
    value.includes("light")
  ) {
    style = "Light";

  } else if (
    value.includes("thin")
  ) {
    style = "Thin";
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
      family: "Inter",
      style: wanted
    });

    loadedInterStyles.add(
      wanted
    );

    return wanted;

  } catch (_) {}


  /*
   * Fallback
   */

  try {
    if (
      !loadedInterStyles.has(
        "Regular"
      )
    ) {
      await figma.loadFontAsync({
        family: "Inter",
        style: "Regular"
      });

      loadedInterStyles.add(
        "Regular"
      );
    }

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


/* =========================================================
   FINAL TEXT PLAN

   Screenshot + Flatten 모두 끝난 후
   실제 Tree에서 다시 전체 Text Scan.
========================================================= */

function buildInterTextPlan(
  root,
  stats
) {
  stats.treeScans++;

  clearPluginKey(
    root,
    PD_INTER_TASK
  );

  const tasks = [];


  function walk(node) {
    if (!isAlive(node)) {
      return;
    }


    if (
      safeType(node) === "TEXT"
    ) {
      const marker =
        createTaskMarker(
          "inter"
        );

      setPD(
        node,
        PD_INTER_TASK,
        marker
      );

      tasks.push({
        marker,
        name:
          safeName(node)
      });
    }


    for (
      const child of
      childrenOf(node)
    ) {
      walk(child);
    }
  }


  walk(root);

  return tasks;
}


/* =========================================================
   TEXT → INTER
========================================================= */

async function convertTextNodeToInter(node) {
  if (
    !isAlive(node) ||
    safeType(node) !== "TEXT"
  ) {
    return {
      changed: false,
      convertedSegments: 0,
      failedSegments: 0,
      alreadyInter: false,
      reason: "not-text"
    };
  }


  let segments;

  try {
    segments =
      node.getStyledTextSegments(
        ["fontName"]
      );

  } catch (_) {
    return {
      changed: false,
      convertedSegments: 0,
      failedSegments: 1,
      alreadyInter: false,
      reason:
        "segment-read-failed"
    };
  }


  /*
   * Empty text
   */

  if (
    segments.length === 0
  ) {
    try {
      if (
        isInterFontName(
          node.fontName
        )
      ) {
        return {
          changed: false,
          convertedSegments: 0,
          failedSegments: 0,
          alreadyInter: true,
          reason:
            "already-inter"
        };
      }
    } catch (_) {}


    const style =
      await loadInterStyle(
        "Regular"
      );


    if (!style) {
      return {
        changed: false,
        convertedSegments: 0,
        failedSegments: 1,
        alreadyInter: false,
        reason:
          "inter-unavailable"
      };
    }


    try {
      node.fontName = {
        family: "Inter",
        style
      };

      return {
        changed: true,
        convertedSegments: 1,
        failedSegments: 0,
        alreadyInter: false,
        reason:
          "font-converted"
      };

    } catch (_) {
      return {
        changed: false,
        convertedSegments: 0,
        failedSegments: 1,
        alreadyInter: false,
        reason:
          "font-set-failed"
      };
    }
  }


  let convertedSegments = 0;
  let failedSegments = 0;
  let nonInterSegments = 0;


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


    nonInterSegments++;


    const originalFont =
      segment.fontName;


    if (
      originalFont &&
      originalFont !== figma.mixed
    ) {
      /*
       * Text를 수정하기 전에 원본 Font도 로드.
       */
      await loadFontOnce(
        originalFont
      );
    }


    const sourceStyle =
      originalFont &&
      originalFont !== figma.mixed
        ? originalFont.style
        : "Regular";


    const targetStyle =
      await loadInterStyle(
        mapInterStyle(
          sourceStyle
        )
      );


    if (!targetStyle) {
      failedSegments++;
      continue;
    }


    try {
      node.setRangeFontName(
        segment.start,
        segment.end,
        {
          family: "Inter",
          style: targetStyle
        }
      );

      convertedSegments++;

    } catch (_) {
      /*
       * Regular 최종 fallback
       */

      const regular =
        await loadInterStyle(
          "Regular"
        );


      if (!regular) {
        failedSegments++;
        continue;
      }


      try {
        node.setRangeFontName(
          segment.start,
          segment.end,
          {
            family: "Inter",
            style: regular
          }
        );

        convertedSegments++;

      } catch (_) {
        failedSegments++;
      }
    }
  }


  if (
    nonInterSegments === 0
  ) {
    return {
      changed: false,
      convertedSegments: 0,
      failedSegments: 0,
      alreadyInter: true,
      reason:
        "already-inter"
    };
  }


  return {
    changed:
      convertedSegments > 0,

    convertedSegments,
    failedSegments,

    alreadyInter: false,

    reason:
      failedSegments === 0
        ? "font-converted"
        : convertedSegments > 0
          ? "partially-converted"
          : "font-conversion-failed"
  };
}


/* =========================================================
   INTER PHASE

   PNG Verification 없음.
========================================================= */

async function processInterPhase(
  state,
  stats
) {
  if (
    !convertFontToInter
  ) {
    return;
  }


  const tasks =
    buildInterTextPlan(
      state.root,
      stats
    );


  /*
   * 여기서 task별 PNG 검증은 없다.
   *
   * Text 수정 API 자체는 각 Text에 호출해야 하지만
   * Rendering 비교나 clone/rollback은 하지 않으므로
   * 기존 버전보다 훨씬 빠르다.
   */

  for (
    const task of tasks
  ) {
    const text =
      findByPluginData(
        state.root,
        PD_INTER_TASK,
        task.marker
      );


    if (!text) {
      stats.failedFontConversions++;

      addReport(
        stats,
        "Font → Inter",
        "REJECTED",
        null,
        `"${task.name}" · Text missing`
      );

      continue;
    }


    const conversion =
      await convertTextNodeToInter(
        text
      );


    if (conversion.changed) {
      stats.convertedTexts++;

      stats.convertedFontSegments +=
        conversion.convertedSegments || 0;


      if (
        conversion.failedSegments > 0
      ) {
        stats.failedFontConversions++;

        addReport(
          stats,
          "Font → Inter",
          "REJECTED",
          text,
          `${conversion.convertedSegments} converted / ${conversion.failedSegments} failed`
        );

      } else {
        addReport(
          stats,
          "Font → Inter",
          "SUCCESS",
          text,
          `${conversion.convertedSegments} segment(s)`
        );
      }

      continue;
    }


    if (
      conversion.alreadyInter
    ) {
      addReport(
        stats,
        "Font → Inter",
        "SKIPPED",
        text,
        "Already Inter"
      );

      continue;
    }


    stats.failedFontConversions++;

    addReport(
      stats,
      "Font → Inter",
      "REJECTED",
      text,
      conversion.reason
    );
  }
}


/* =========================================================
   NAMING
========================================================= */

function looksLikeScreenshotName(name) {
  const value =
    String(name || "")
      .toLowerCase();

  return (
    value.includes("screenshot") ||
    value.includes("screen shot") ||
    value.includes("스크린샷")
  );
}


function looksLikeIconName(name) {
  const value =
    String(name || "")
      .toLowerCase();

  return (
    value === "icon" ||
    value.startsWith("icon/") ||
    value.includes("/icon") ||
    value.startsWith("ic_") ||
    value.includes("/ic_") ||
    value.includes("material-symbol") ||
    value.includes("material_symbol")
  );
}


function looksLikeIcon(node) {
  return (
    looksLikeIconName(
      safeName(node)
    ) ||
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
  const type =
    safeType(node);


  if (
    type === "LINE"
  ) {
    return true;
  }


  if (
    [
      "RECTANGLE",
      "VECTOR"
    ].includes(type) &&
    !hasImageFill(node)
  ) {
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
    } catch (_) {}
  }


  return false;
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


  if (
    looksLikeScreenshotName(
      safeName(node)
    )
  ) {
    return true;
  }


  try {
    return (
      root.width > 0 &&
      root.height > 0 &&

      node.width /
        root.width >= 0.7 &&

      node.height /
        root.height >= 0.5
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
  const type =
    safeType(node);


  if (
    type === "FRAME" &&
    isAutoLayout(node)
  ) {
    return "auto layout";
  }


  if (
    type === "FRAME" &&
    looksLikeIPhone(node)
  ) {
    return "iphone";
  }


  if (
    type === "FRAME"
  ) {
    return "frame";
  }


  if (
    type === "GROUP"
  ) {
    return "group";
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


  /*
   * Representative root
   */

  if (
    node === root
  ) {
    return current;
  }


  /*
   * LID
   */

  if (
    isLidName(current)
  ) {
    return current;
  }


  /*
   * Text
   */

  if (
    type === "TEXT"
  ) {
    return (
      renameTextToHyphen
        ? "-"
        : current
    );
  }


  /*
   * Image
   */

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
    return "line";
  }


  if (
    looksLikeIcon(node)
  ) {
    return "icon";
  }


  if (
    isShapeNode(node)
  ) {
    return "shape";
  }


  /*
   * Optional container naming
   */

  if (
    type === "FRAME" ||
    type === "GROUP"
  ) {
    if (!renameContainers) {
      return current;
    }

    return (
      getContainerLayerName(node) ||
      current
    );
  }


  if (
    type === "COMPONENT"
  ) {
    return "component";
  }


  if (
    type === "INSTANCE"
  ) {
    return "instance";
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

function getOrderBounds(node) {
  const box =
    safeBounds(node);

  if (!box) {
    return null;
  }

  return {
    x: box.x,
    y: box.y,

    width:
      box.width,

    height:
      box.height,

    right:
      box.x +
      box.width,

    bottom:
      box.y +
      box.height
  };
}


function isSameVisualRow(a, b) {
  if (!a || !b) {
    return false;
  }


  if (
    Math.abs(
      a.y - b.y
    ) <=
      ROW_Y_TOLERANCE
  ) {
    return true;
  }


  const overlap =
    Math.min(
      a.bottom,
      b.bottom
    ) -
    Math.max(
      a.y,
      b.y
    );


  return (
    overlap > 0 &&
    overlap >=
      Math.min(
        a.height,
        b.height
      ) *
      0.5
  );
}


function boundsOverlap(a, b) {
  return !!(
    a &&
    b &&
    !(
      a.right <= b.x ||
      b.right <= a.x ||
      a.bottom <= b.y ||
      b.bottom <= a.y
    )
  );
}


function buildVisualRows(items) {
  const sorted =
    [...items]
      .sort(
        (a, b) => {
          if (
            !a.bounds &&
            !b.bounds
          ) {
            return (
              a.originalPanelIndex -
              b.originalPanelIndex
            );
          }


          if (!a.bounds) {
            return 1;
          }

          if (!b.bounds) {
            return -1;
          }


          const dy =
            a.bounds.y -
            b.bounds.y;


          return (
            Math.abs(dy) >
              ROW_Y_TOLERANCE
              ? dy
              : (
                  a.bounds.x -
                  b.bounds.x
                )
          );
        }
      );


  const rows = [];


  for (
    const item of sorted
  ) {
    if (!item.bounds) {
      rows.push({
        y: Infinity,
        items: [item]
      });

      continue;
    }


    let row =
      rows.find(
        candidate =>
          candidate.items.some(
            existing =>
              existing.bounds &&
              isSameVisualRow(
                existing.bounds,
                item.bounds
              )
          )
      );


    if (!row) {
      row = {
        y:
          item.bounds.y,

        items: []
      };

      rows.push(row);
    }


    row.items.push(item);

    row.y =
      Math.min(
        row.y,
        item.bounds.y
      );
  }


  rows.sort(
    (a, b) =>
      a.y - b.y
  );


  for (
    const row of rows
  ) {
    row.items.sort(
      (a, b) => {
        if (!a.bounds) {
          return 1;
        }

        if (!b.bounds) {
          return -1;
        }


        const dx =
          a.bounds.x -
          b.bounds.x;


        if (
          Math.abs(dx) > 0.1
        ) {
          return dx;
        }


        return (
          a.bounds.y -
          b.bounds.y
        );
      }
    );
  }


  return rows;
}


function buildSafeDesiredPanelOrder(root) {
  const children =
    childrenOf(root);

  const currentPanel =
    [...children]
      .reverse();


  const items =
    currentPanel.map(
      (node, index) => ({
        node,

        bounds:
          getOrderBounds(node),

        originalPanelIndex:
          index,

        desiredRank: 0,

        outgoing:
          new Set(),

        indegree: 0
      })
    );


  const visual = [];

  for (
    const row of
    buildVisualRows(items)
  ) {
    visual.push(
      ...row.items
    );
  }


  visual.forEach(
    (item, index) => {
      item.desiredRank =
        index;
    }
  );


  /*
   * Overlap → existing Z order
   */

  for (
    let i = 0;
    i < items.length;
    i++
  ) {
    for (
      let j =
        i + 1;
      j < items.length;
      j++
    ) {
      if (
        boundsOverlap(
          items[i].bounds,
          items[j].bounds
        )
      ) {
        items[i]
          .outgoing
          .add(
            items[j]
          );

        items[j]
          .indegree++;
      }
    }
  }


  const available =
    items.filter(
      item =>
        item.indegree === 0
    );


  const output = [];


  while (
    available.length
  ) {
    available.sort(
      (a, b) =>
        (
          a.desiredRank -
          b.desiredRank
        ) ||
        (
          a.originalPanelIndex -
          b.originalPanelIndex
        )
    );


    const current =
      available.shift();

    output.push(current);


    for (
      const next of
      current.outgoing
    ) {
      next.indegree--;

      if (
        next.indegree === 0
      ) {
        available.push(next);
      }
    }
  }


  return (
    output.length === items.length
      ? output
      : null
  );
}


async function reorderRootLayers(root) {
  if (!isAlive(root)) {
    return {
      root,
      changed: false,
      reason: "root-missing"
    };
  }


  if (isAutoLayout(root)) {
    return {
      root,
      changed: false,
      reason:
        "root-auto-layout"
    };
  }


  const children =
    childrenOf(root);


  if (
    children.length <= 1
  ) {
    return {
      root,
      changed: false,
      reason: "single-layer"
    };
  }


  const panel =
    buildSafeDesiredPanelOrder(
      root
    );


  if (!panel) {
    return {
      root,
      changed: false,
      reason: "z-order-cycle"
    };
  }


  const desiredChildren =
    panel
      .map(
        item =>
          item.node
      )
      .reverse();


  const changed =
    children.some(
      (node, index) =>
        node !==
        desiredChildren[index]
    );


  if (!changed) {
    return {
      root,
      changed: false,
      reason:
        "already-ordered"
    };
  }


  for (
    let i = 0;
    i <
      desiredChildren.length;
    i++
  ) {
    const node =
      desiredChildren[i];

    if (isAlive(node)) {
      root.insertChild(
        i,
        node
      );
    }
  }


  return {
    root,
    changed: true,
    reason: "ordered"
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


  if (tx.accepted) {
    stats.orderChanged++;

    addReport(
      stats,
      "Layer Order",
      "SUCCESS",
      state.root,
      "Top → Bottom / Left → Right"
    );

  } else if (tx.attempted) {
    stats.orderRejected++;

    addReport(
      stats,
      "Layer Order",
      "REJECTED",
      state.root,
      tx.reason ===
        "visual-changed"
        ? "Z-order 변경 감지"
        : tx.reason
    );
  }
}


/* =========================================================
   ANALYSIS
========================================================= */

function countAllLayers(root) {
  let count = 0;

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
      isContainer(node) &&
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


  if (index < 0) {
    return null;
  }


  /*
   * Restore original location.
   */

  working.x =
    original.x;

  working.y =
    original.y;


  /*
   * Root Screen name always preserved.
   */

  try {
    working.name =
      original.name;
  } catch (_) {}


  parent.insertChild(
    index,
    working
  );


  safeRemove(original);


  return working;
}


/* =========================================================
   PROCESS ROOT

   IMPORTANT:
   Structural phase → re-scan → next phase.

   No stale global execution plan.
========================================================= */

async function processRoot(
  originalRoot
) {
  const stats =
    createStats();


  if (!isAlive(originalRoot)) {
    return {
      success: false,
      root: originalRoot,
      stats,
      fatalReason:
        "Root missing"
    };
  }


  const parent =
    safeParent(
      originalRoot
    );


  if (
    !parent ||
    safeType(parent) !==
      "PAGE"
  ) {
    return {
      success: false,
      root: originalRoot,
      stats,
      fatalReason:
        "Screen must be direct Page child."
    };
  }


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
  } catch (error) {
    return {
      success: false,
      root: originalRoot,
      stats,

      fatalReason:
        error &&
        error.message
          ? error.message
          : String(error)
    };
  }


  try {
    state.root.name =
      originalScreenName;
  } catch (_) {}


  try {

    /* =====================================================
       PHASE 1
       Garbage
    ===================================================== */

    markSelectedGarbage(
      originalRoot,
      state.root
    );


    await processGarbage(
      state,
      stats
    );


    /* =====================================================
       PHASE 2
       Root → Frame
    ===================================================== */

    await processRootConversion(
      state,
      stats
    );


    try {
      state.root.name =
        originalScreenName;
    } catch (_) {}


    /* =====================================================
       PHASE 3
       Instance

       자체적으로 round마다 re-scan.
    ===================================================== */

    await processInstancePhase(
      state,
      stats
    );


    /* =====================================================
       PHASE 4
       Screenshot / Mask / Clip

       현재 Tree 새 Scan.
    ===================================================== */

    await processScreenshotPhase(
      state,
      stats
    );


    /* =====================================================
       PHASE 5
       Flatten

       Screenshot Plan은 여기서 절대 재사용하지 않는다.
       새로운 Tree에서 Flatten Plan 생성.
    ===================================================== */

    await processFlattenPhase(
      state,
      stats
    );


    /* =====================================================
       PHASE 6
       Inter

       Final Tree 전체 Text 재검색.
       PNG verification 없음.
    ===================================================== */

    await processInterPhase(
      state,
      stats
    );


    /* =====================================================
       PHASE 7
       Naming
    ===================================================== */

    processNaming(
      state.root,
      stats
    );


    try {
      state.root.name =
        originalScreenName;
    } catch (_) {}


    /* =====================================================
       PHASE 8
       Layer Order
    ===================================================== */

    await processOrderPhase(
      state,
      stats
    );


    /*
     * Order rollback이 발생했더라도
     * root name을 다시 강제 보존.
     */

    try {
      state.root.name =
        originalScreenName;
    } catch (_) {}


    /* =====================================================
       PHASE 9
       Remove internal data
    ===================================================== */

    clearInternalPluginData(
      state.root
    );


    /* =====================================================
       PHASE 10
       Commit
    ===================================================== */

    const committed =
      commitWorkingRoot(
        originalRoot,
        state.root
      );


    if (!committed) {
      if (
        state.root &&
        isAlive(state.root)
      ) {
        safeRemove(
          state.root
        );
      }

      return {
        success: false,
        root: originalRoot,
        stats,
        fatalReason:
          "Commit failed"
      };
    }


    try {
      committed.name =
        originalScreenName;
    } catch (_) {}


    stats.finalLayers =
      childrenOf(
        committed
      ).length;


    return {
      success: true,
      root: committed,
      stats,
      fatalReason: null
    };


  } catch (error) {
    /*
     * Fatal processing error.
     *
     * Original remains untouched because we were working on clone.
     */

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
      root: originalRoot,
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
  const result = [];

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
        result.push(node);
      }
    } catch (_) {}
  }

  return result;
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
     VIEW GARBAGE
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
        !node ||
        node.type === "PAGE" ||
        node.type === "DOCUMENT"
      ) {
        return;
      }


      figma.currentPage.selection =
        [node];


      figma.viewport.scrollAndZoomIntoView(
        [node]
      );

    } catch (_) {}


    /*
     * IMPORTANT:
     * 보기 버튼은 Analyze root를 변경하지 않는다.
     */

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
        type: "error",

        message:
          "정리할 최상위 Screen Layer를 선택해주세요."
      });

      return;
    }


    if (
      !selection.every(
        isSupportedRoot
      )
    ) {
      figma.ui.postMessage({
        type: "error",

        message:
`지원하지 않는 Layer가 포함되어 있습니다.

지원 타입
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
      type: "analysis",
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

    /*
     * Analyze 없이 Clean 눌렀을 경우 fallback.
     */

    if (
      analyzedRootIds.length === 0
    ) {
      analyzedRootIds =
        [
          ...figma.currentPage.selection
        ]
          .filter(
            node =>
              isAlive(node) &&
              isSupportedRoot(node)
          )
          .map(
            safeId
          )
          .filter(
            Boolean
          );
    }


    const roots =
      await getAnalyzedRoots();


    if (
      roots.length === 0
    ) {
      figma.ui.postMessage({
        type: "error",

        message:
          "Analyze했던 Screen을 찾을 수 없습니다. Screen을 다시 선택한 뒤 Analyze Screen을 실행해주세요."
      });

      return;
    }


    /* =====================================================
       UI OPTIONS
    ===================================================== */

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


    figma.ui.postMessage({
      type: "processing"
    });


    const resultRoots = [];


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
      binarySplits: 0,

      report: [],
      failureReasons: []
    };


    /* =====================================================
       ROOTS
    ===================================================== */

    for (
      const root of roots
    ) {
      const originalName =
        safeName(root);


      try {
        const processResult =
          await processRoot(
            root
          );


        if (
          processResult.root &&
          isAlive(
            processResult.root
          )
        ) {
          resultRoots.push(
            processResult.root
          );
        }


        if (
          processResult.success
        ) {
          total.committed++;

        } else {
          total.rolledBack++;

          if (
            processResult.fatalReason
          ) {
            total.failureReasons.push({
              screen:
                originalName,

              reason:
                processResult.fatalReason
            });
          }
        }


        const stats =
          processResult.stats;


        for (
          const key of
          Object.keys(stats)
        ) {
          if (
            key === "report"
          ) {
            total.report.push(
              ...stats.report
            );

            continue;
          }


          if (
            key in total &&
            typeof total[key] ===
              "number" &&
            typeof stats[key] ===
              "number"
          ) {
            total[key] +=
              stats[key];
          }
        }

      } catch (error) {
        total.rolledBack++;


        total.failureReasons.push({
          screen:
            originalName,

          reason:
            error &&
            error.message
              ? error.message
              : String(error)
        });


        if (isAlive(root)) {
          resultRoots.push(root);
        }
      }
    }


    /* =====================================================
       SELECT RESULT
    ===================================================== */

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


    /* =====================================================
       COMPLETE
    ===================================================== */

    figma.ui.postMessage({
      type: "complete",
      result: total
    });


    /* =====================================================
       PERFORMANCE LOG
    ===================================================== */

    console.log(
      "========================================"
    );

    console.log(
      "SCREEN LAYER CLEANER"
    );

    console.log(
      "========================================"
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
      "Tree Scans:",
      total.treeScans
    );

    console.log(
      "Visual Batch Checks:",
      total.visualBatchChecks
    );

    console.log(
      "Binary Splits:",
      total.binarySplits
    );

    console.log(
      "Fast Garbage:",
      total.fastGarbage
    );

    console.log(
      "Deleted Garbage:",
      total.removedGarbage
    );

    console.log(
      "Detached Instance:",
      total.detachedInstances
    );

    console.log(
      "Rejected Instance:",
      total.rejectedInstances
    );

    console.log(
      "Screenshot Bake:",
      total.screenshotBaked
    );

    console.log(
      "Fast Flatten:",
      total.fastFlatten
    );

    console.log(
      "Flattened:",
      total.flattenedContainers
    );

    console.log(
      "Inter Text:",
      total.convertedTexts
    );

    console.log(
      "Inter Segments:",
      total.convertedFontSegments
    );

    console.log(
      "Font Failures:",
      total.failedFontConversions
    );

    console.log(
      "Renamed:",
      total.renamedLayers
    );

    console.log(
      "Order:",
      total.orderChanged
    );

    console.log(
      "Options:",
      {
        convertFontToInter,
        renameTextToHyphen,
        renameContainers
      }
    );


    try {
      console.table(
        total.report
      );
    } catch (_) {
      console.log(
        total.report
      );
    }


    if (
      total.failureReasons.length
    ) {
      console.error(
        "Fatal Failures:",
        total.failureReasons
      );
    }


    /* =====================================================
       NOTIFY
    ===================================================== */

    if (
      total.rolledBack === 0
    ) {
      figma.notify(
        `Cleanup 완료 · Garbage ${total.removedGarbage} · Detach ${total.detachedInstances} · Flatten ${total.flattenedContainers} · Inter ${total.convertedTexts}`
      );

    } else {
      figma.notify(
        `Cleanup 완료 · ${total.committed}개 적용 / ${total.rolledBack}개 원본 유지`
      );
    }


    return;
  }
};
