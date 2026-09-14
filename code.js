figma.showUI(__html__, {
  width: 440,
  height: 760,
  themeColors: true
});


/* =========================================================
   SCREEN LAYER CLEANER
   BATCH + BINARY ISOLATION ENGINE

   제1법칙
   ---------------------------------------------------------
   디자인 화면의 시각적 결과는 변경하지 않는다.

   속도 전략
   ---------------------------------------------------------
   1. Tree 전체 탐색 횟수 최소화
   2. Fast-safe 작업은 PNG 검증 없이 처리
   3. 위험 작업은 여러 개를 한 번에 Batch 검증
   4. Batch 실패 시에만 Binary Isolation
      32개 -> 16/16 -> 8/8 ...
   5. 레이어마다 Root Clone / PNG Export 하지 않음
   6. 구조 변경 후 필요한 시점에만 재탐색

   유지 기능
   ---------------------------------------------------------
   - Garbage Analyze / Review / 선택 삭제
   - Hidden / Transparent / Empty / Outside Screen 추적
   - Root -> Frame
   - Instance Detach
   - Mask / Real Clip -> screenshot
   - Frame / Group / Auto Layout Flatten
   - 가능한 범위까지 1 Depth
   - LID 보호
   - Text "-" 옵션
   - Font -> Inter 옵션
   - icon / line / shape / image / screenshot
   - frame / group / instance / component / iphone
   - 화면 위->아래 / 같은 줄 좌->우
   - 겹치는 Layer 기존 Z-order 보존
========================================================= */


/* =========================================================
   OPTIONS / STATE
========================================================= */

let renameTextToHyphen = false;
let convertFontToInter = false;

let approvedGarbageIds = new Set();
let analyzedRootIds = [];


/*
 * Working Root는 원본 화면에서 멀리 떨어진 곳에 둔다.
 */
const WORK_OFFSET_X = 30000;
const CHECKPOINT_OFFSET_X = 60000;


/*
 * Ordering
 */
const ROW_Y_TOLERANCE = 6;


/*
 * Fast Flatten Geometry 검사
 */
const GEOMETRY_TOLERANCE = 0.25;


/*
 * 구조 변경 후 Instance만 최대 2회 재탐색.
 *
 * 기존처럼 10~30번 전체 Tree를 계속 재탐색하지 않는다.
 */
const MAX_INSTANCE_ROUNDS = 2;


/* =========================================================
   PLUGIN DATA
========================================================= */

const PD_GARBAGE_ID = "slc_garbage_id";

const PD_TASK_ID = "slc_task_id";

const PD_SKIP_DETACH = "slc_skip_detach";
const PD_SKIP_SCREENSHOT = "slc_skip_screenshot";
const PD_SKIP_FLATTEN = "slc_skip_flatten";

const PD_INTER_DONE = "slc_inter_done";


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

    /*
     * 성능 확인용
     */
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
    return node
      ? node.type
      : null;
  } catch (_) {
    return null;
  }
}


function safeName(node) {
  try {
    return node
      ? node.name
      : "";
  } catch (_) {
    return "";
  }
}


function safeId(node) {
  try {
    return node
      ? node.id
      : null;
  } catch (_) {
    return null;
  }
}


function safeParent(node) {
  try {
    return node
      ? node.parent
      : null;
  } catch (_) {
    return null;
  }
}


function isAlive(node) {
  if (!node) {
    return false;
  }

  try {
    return !!node.parent;
  } catch (_) {
    return false;
  }
}


function childrenOf(node) {
  if (!isAlive(node)) {
    return [];
  }

  try {
    if (!("children" in node)) {
      return [];
    }

    return [...node.children];

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
    return node.absoluteTransform;
  } catch (_) {
    return null;
  }
}


function safeRemove(node) {
  if (!isAlive(node)) {
    return false;
  }

  try {
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
  const type =
    safeType(node);

  return (
    type === "FRAME" ||
    type === "GROUP" ||
    type === "COMPONENT" ||
    type === "INSTANCE"
  );
}


function isSupportedRoot(node) {
  return isContainer(node);
}


function isAutoLayout(node) {
  if (!isAlive(node)) {
    return false;
  }

  try {
    return (
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
    if (
      "layoutPositioning" in node &&
      node.layoutPositioning === "ABSOLUTE"
    ) {
      return false;
    }
  } catch (_) {}


  return true;
}


/* =========================================================
   TRANSFORM
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
  if (!isAlive(node)) {
    return "";
  }

  try {
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
  if (!isAlive(node)) {
    return;
  }

  try {
    node.setPluginData(
      key,
      value
    );
  } catch (_) {}
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
    PD_TASK_ID,
    PD_SKIP_DETACH,
    PD_SKIP_SCREENSHOT,
    PD_SKIP_FLATTEN,
    PD_INTER_DONE
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
   UNIQUE TASK MARKER
========================================================= */

let taskCounter = 0;


function createTaskMarker(prefix) {
  taskCounter++;

  return (
    `${prefix}_${Date.now()}_${taskCounter}`
  );
}


/* =========================================================
   PATH MAP
   Analyze 당시 Garbage ID -> Clone Layer 대응용
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


function sameBytes(
  a,
  b
) {
  if (
    !a ||
    !b
  ) {
    return false;
  }


  if (
    a.length !==
    b.length
  ) {
    return false;
  }


  for (
    let i = 0;
    i < a.length;
    i++
  ) {
    if (
      a[i] !==
      b[i]
    ) {
      return false;
    }
  }


  return true;
}


/* =========================================================
   WORKING ROOT
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
   BATCH VISUAL TRANSACTION

   여러 Task를 한 번에 처리한다.

   BEFORE PNG        1회
   CHECKPOINT CLONE  1회
   N개 작업
   AFTER PNG         1회

   PASS
   → N개 전부 확정

   FAIL
   → 전체 Restore 후 Binary Isolation
========================================================= */

async function runVisualBatchTransaction(
  state,
  tasks,
  applyTask,
  stats
) {
  if (
    !state ||
    !isAlive(state.root) ||
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


  let checkpoint =
    null;


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


  const results =
    [];


  let changedAny =
    false;


  try {

    /*
     * 하나씩 검증하는 것이 아니라
     * Batch 내부에서는 연속 실행한다.
     */
    for (
      const task of tasks
    ) {
      let result;

      try {
        result =
          await applyTask(
            state.root,
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
        changedAny =
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


    return {
      accepted: false,
      attempted: true,
      reason: "batch-operation-error",
      results,
      error
    };
  }


  /*
   * 아무 변경도 없었다면
   * Checkpoint 제거 후 종료.
   */
  if (!changedAny) {
    safeRemove(
      checkpoint
    );


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


  /*
   * Render까지 실패하면
   * Batch 전체 Restore.
   */
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


  /*
   * ★ Batch 전체 PASS
   */
  if (
    sameBytes(
      before,
      after
    )
  ) {
    safeRemove(
      checkpoint
    );


    return {
      accepted: true,
      attempted: true,
      reason: "visual-identical",
      results
    };
  }


  /*
   * ★ Batch FAIL
   *
   * 현재 작업본 버리고
   * Checkpoint 복원.
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


  return {
    accepted: false,
    attempted: true,
    reason: "visual-changed",
    results
  };
}


/* =========================================================
   BINARY ISOLATION

   32개 Batch 실패
   ↓
   16 / 16
   ↓
   실패한 절반만 다시 8 / 8
   ↓
   최종 문제 Layer만 Reject
========================================================= */

async function processBatchWithIsolation({
  state,
  tasks,
  applyTask,
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


  const tx =
    await runVisualBatchTransaction(
      state,
      tasks,
      applyTask,
      stats
    );


  /*
   * Batch 전체 PASS
   */
  if (tx.accepted) {

    const resultMap =
      new Map();


    for (
      const item of tx.results
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
        await onAccepted(
          task,
          result
        );

      } else {
        await onSkipped(
          task,
          result || {
            reason: "no-change"
          }
        );
      }
    }


    return;
  }


  /*
   * 실제 변경이 하나도 없었던 Batch.
   */
  if (
    !tx.attempted
  ) {
    for (
      const task of tasks
    ) {
      await onSkipped(
        task,
        {
          reason:
            tx.reason
        }
      );
    }

    return;
  }


  /*
   * 최종 1개까지 좁혀짐.
   *
   * 이 Layer만 Reject.
   */
  if (
    tasks.length === 1
  ) {
    await onRejected(
      tasks[0],
      tx
    );

    return;
  }


  /*
   * ★ 실패한 Batch를 반으로 나눈다.
   */
  stats.binarySplits++;


  const middle =
    Math.ceil(
      tasks.length / 2
    );


  const left =
    tasks.slice(
      0,
      middle
    );

  const right =
    tasks.slice(
      middle
    );


  await processBatchWithIsolation({
    state,
    tasks: left,
    applyTask,
    stats,
    onAccepted,
    onRejected,
    onSkipped
  });


  await processBatchWithIsolation({
    state,
    tasks: right,
    applyTask,
    stats,
    onAccepted,
    onRejected,
    onSkipped
  });
}


/* =========================================================
   LID
========================================================= */

function isLidName(name) {
  if (!name) {
    return false;
  }


  const value =
    String(name)
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
   PAINT / EFFECT
========================================================= */

function hasVisiblePaint(
  paints
) {
  if (!Array.isArray(paints)) {
    return false;
  }


  return paints.some(
    paint => {

      if (
        paint.visible === false
      ) {
        return false;
      }


      if (
        typeof paint.opacity === "number" &&
        paint.opacity === 0
      ) {
        return false;
      }


      return true;
    }
  );
}


function hasVisibleFill(node) {
  try {
    if (
      !("fills" in node) ||
      node.fills === figma.mixed ||
      !Array.isArray(node.fills)
    ) {
      return false;
    }


    return hasVisiblePaint(
      node.fills
    );

  } catch (_) {
    return false;
  }
}


function hasVisibleStroke(node) {
  try {
    if (
      !("strokes" in node) ||
      node.strokes === figma.mixed ||
      !Array.isArray(node.strokes)
    ) {
      return false;
    }


    return hasVisiblePaint(
      node.strokes
    );

  } catch (_) {
    return false;
  }
}


function hasVisibleEffects(node) {
  try {
    if (
      !("effects" in node) ||
      !Array.isArray(node.effects)
    ) {
      return false;
    }


    return node.effects.some(
      effect =>
        effect.visible !== false
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
    if (
      !("fills" in node) ||
      node.fills === figma.mixed ||
      !Array.isArray(node.fills)
    ) {
      return false;
    }


    return node.fills.some(
      fill =>
        fill.type === "IMAGE" &&
        fill.visible !== false
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
      isMaskNode(child)
    ) {
      return true;
    }


    if (
      containsMask(child)
    ) {
      return true;
    }
  }


  return false;
}


function actuallyClipsChildren(node) {
  if (!isAlive(node)) {
    return false;
  }


  try {
    if (
      !("clipsContent" in node) ||
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


  const left =
    box.x;

  const top =
    box.y;

  const right =
    box.x + box.width;

  const bottom =
    box.y + box.height;


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
      childBox.x < left - 0.5 ||
      childBox.y < top - 0.5 ||
      childBox.x + childBox.width > right + 0.5 ||
      childBox.y + childBox.height > bottom + 0.5
    ) {
      return true;
    }
  }


  return false;
}


/* =========================================================
   GARBAGE DETECTION
========================================================= */

function isShapeNode(node) {
  const type =
    safeType(node);


  return (
    type === "RECTANGLE" ||
    type === "ELLIPSE" ||
    type === "POLYGON" ||
    type === "STAR" ||
    type === "VECTOR" ||
    type === "BOOLEAN_OPERATION" ||
    type === "LINE"
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
  if (
    !isShapeNode(node) ||
    isMaskNode(node)
  ) {
    return false;
  }


  return (
    !hasVisibleFill(node) &&
    !hasVisibleStroke(node) &&
    !hasVisibleEffects(node)
  );
}


function isEmptyContainer(node) {
  if (!isContainer(node)) {
    return false;
  }


  return (
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


  if (
    !nodeBox ||
    !rootBox
  ) {
    return false;
  }


  const nodeRight =
    nodeBox.x +
    nodeBox.width;

  const nodeBottom =
    nodeBox.y +
    nodeBox.height;


  const rootRight =
    rootBox.x +
    rootBox.width;

  const rootBottom =
    rootBox.y +
    rootBox.height;


  return (
    nodeRight <= rootBox.x ||
    nodeBox.x >= rootRight ||
    nodeBottom <= rootBox.y ||
    nodeBox.y >= rootBottom
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


  /*
   * Hidden
   */
  try {
    if (
      "visible" in node &&
      node.visible === false
    ) {
      return "Hidden · visible=false";
    }
  } catch (_) {}


  /*
   * Transparent
   */
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


  if (
    isTinyNode(node)
  ) {
    return "Zero / Tiny Size";
  }


  if (
    isEmptyVisualShape(node)
  ) {
    return "Empty Shape";
  }


  if (
    isEmptyContainer(node)
  ) {
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


/* =========================================================
   FAST SAFE GARBAGE
========================================================= */

function isFastSafeGarbage(
  node,
  root
) {
  if (
    !isAlive(node) ||
    node === root ||
    isMaskNode(node)
  ) {
    return false;
  }


  /*
   * Auto Layout Flow에 들어간 Layer는
   * 삭제가 형제 위치를 바꿀 수 있다.
   */
  if (
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


  /*
   * 빈 Shape
   */
  if (
    isEmptyVisualShape(node)
  ) {
    return true;
  }


  /*
   * 빈 Container
   */
  if (
    isEmptyContainer(node)
  ) {
    return true;
  }


  /*
   * Clip Screen 밖
   */
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


/* =========================================================
   GARBAGE ANALYZE
========================================================= */

function collectGarbageItems(root) {
  const result =
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
      result.push({
        id:
          safeId(node) || "",

        name,

        type:
          safeType(node) || "UNKNOWN",

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


    if (!node) {
      continue;
    }


    setPD(
      node,
      PD_GARBAGE_ID,
      id
    );
  }
}


/* =========================================================
   GARBAGE TASK PLAN

   부모 Garbage가 선택되어 있으면
   그 내부의 선택 Garbage는 별도 Task로 만들지 않는다.
========================================================= */

function buildGarbageTasks(root) {
  const result =
    [];


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


    const markerId =
      getPD(
        node,
        PD_GARBAGE_ID
      );


    const selected =
      !!markerId &&
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
        PD_TASK_ID,
        marker
      );


      result.push({
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


  return result;
}


/* =========================================================
   PROCESS GARBAGE
========================================================= */

async function processGarbage(
  state,
  stats
) {
  const tasks =
    buildGarbageTasks(
      state.root
    );


  const fastTasks =
    tasks.filter(
      task =>
        task.fast
    );


  const riskyTasks =
    tasks.filter(
      task =>
        !task.fast
    );


  /* -------------------------------------------------------
     FAST SAFE
     ------------------------------------------------------- */

  for (
    const task of fastTasks
  ) {
    const node =
      findByPluginData(
        state.root,
        PD_TASK_ID,
        task.marker
      );


    if (!node) {
      continue;
    }


    if (
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
        `${task.type} "${task.name}" · ${task.reason} · Fast`
      );
    }
  }


  /* -------------------------------------------------------
     RISKY → BATCH + BINARY
     ------------------------------------------------------- */

  await processBatchWithIsolation({
    state,

    tasks:
      riskyTasks,

    stats,

    applyTask:
      async (root, task) => {

        const node =
          findByPluginData(
            root,
            PD_TASK_ID,
            task.marker
          );


        if (!node) {
          return {
            root,
            changed: false,
            reason: "garbage-missing"
          };
        }


        return {
          root,

          changed:
            safeRemove(node),

          reason:
            "deleted"
        };
      },

    onAccepted:
      async task => {

        stats.removedGarbage +=
          task.count;


        addReport(
          stats,
          "Garbage Delete",
          "SUCCESS",
          null,
          `${task.type} "${task.name}" · ${task.reason} · Batch Verified`
        );
      },

    onRejected:
      async (task, tx) => {

        stats.protectedGarbage +=
          task.count;


        const restored =
          findByPluginData(
            state.root,
            PD_TASK_ID,
            task.marker
          );


        if (restored) {
          /*
           * 앞으로 Garbage 처리에서 다시 잡지 않게
           * 선택 Marker 제거.
           */
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
          tx.reason === "visual-changed"
            ? `삭제 시 Render 변경 · ${task.reason}`
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
      const segment of
      segments
    ) {
      if (
        !segment.fontName ||
        segment.fontName === figma.mixed
      ) {
        continue;
      }


      if (
        !await loadFontOnce(
          segment.fontName
        )
      ) {
        return false;
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
    if (
      !await ensureSubtreeFontsLoaded(
        child
      )
    ) {
      return false;
    }
  }


  return true;
}


/* =========================================================
   EXECUTION PLAN

   Tree DFS 1회로:
   - instances
   - screenshots
   - fastFlatten
   - riskyFlatten
   - texts

   를 전부 수집한다.
========================================================= */

function buildExecutionPlan(
  root,
  stats
) {
  stats.treeScans++;


  const plan = {
    instances: [],
    screenshots: [],
    fastFlatten: [],
    riskyFlatten: [],
    texts: []
  };


  function walk(
    node,
    depth,
    insideInstance
  ) {
    if (!isAlive(node)) {
      return;
    }


    const type =
      safeType(node);


    /*
     * Instance는 먼저 Detach 후
     * 내부 구조를 다음 Plan에서 본다.
     *
     * 이렇게 해야 매번 Instance 안쪽까지
     * 중복으로 탐색하지 않는다.
     */
    if (
      type === "INSTANCE" &&
      node !== root &&
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
        PD_TASK_ID,
        marker
      );


      plan.instances.push({
        marker,
        depth,

        name:
          safeName(node)
      });


      return;
    }


    /*
     * TEXT
     */
    if (
      type === "TEXT" &&
      getPD(
        node,
        PD_INTER_DONE
      ) !== "1"
    ) {
      const marker =
        createTaskMarker(
          "text"
        );


      setPD(
        node,
        PD_TASK_ID,
        marker
      );


      plan.texts.push({
        marker,

        name:
          safeName(node)
      });
    }


    for (
      const child of
      childrenOf(node)
    ) {
      walk(
        child,
        depth + 1,
        insideInstance
      );
    }


    /*
     * Container 후보는
     * child를 먼저 탐색한 뒤 등록한다.
     *
     * 즉 깊은 Container가 먼저 처리된다.
     */
    if (
      node === root
    ) {
      return;
    }


    /*
     * Mask / Real Clip
     */
    if (
      isContainer(node) &&
      type !== "INSTANCE" &&
      getPD(
        node,
        PD_SKIP_SCREENSHOT
      ) !== "1" &&
      (
        containsMask(node) ||
        actuallyClipsChildren(node)
      )
    ) {
      const marker =
        createTaskMarker(
          "screenshot"
        );


      setPD(
        node,
        PD_TASK_ID,
        marker
      );


      plan.screenshots.push({
        marker,
        depth,

        name:
          safeName(node)
      });


      /*
       * Screenshot 대상은 Flatten 대상에서 제외.
       */
      return;
    }


    if (
      isFlattenCandidate(node)
    ) {
      const marker =
        createTaskMarker(
          "flatten"
        );


      setPD(
        node,
        PD_TASK_ID,
        marker
      );


      const task = {
        marker,
        depth,

        name:
          safeName(node),

        type
      };


      if (
        isFastFlattenCandidate(
          node
        )
      ) {
        plan.fastFlatten.push(
          task
        );

      } else {
        plan.riskyFlatten.push(
          task
        );
      }
    }
  }


  walk(
    root,
    0,
    false
  );


  /*
   * 깊은 것부터.
   */
  plan.instances.sort(
    (a, b) =>
      b.depth -
      a.depth
  );


  plan.screenshots.sort(
    (a, b) =>
      b.depth -
      a.depth
  );


  plan.fastFlatten.sort(
    (a, b) =>
      b.depth -
      a.depth
  );


  plan.riskyFlatten.sort(
    (a, b) =>
      b.depth -
      a.depth
  );


  return plan;
}


/* =========================================================
   INSTANCE BATCH
========================================================= */

async function processInstanceTasks(
  state,
  tasks,
  stats
) {
  await processBatchWithIsolation({
    state,
    tasks,
    stats,

    applyTask:
      async (root, task) => {

        const node =
          findByPluginData(
            root,
            PD_TASK_ID,
            task.marker
          );


        if (
          !node ||
          safeType(node) !== "INSTANCE"
        ) {
          return {
            root,
            changed: false,
            reason: "instance-missing"
          };
        }


        const detached =
          node.detachInstance();


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

    onAccepted:
      async task => {

        stats.detachedInstances++;


        addReport(
          stats,
          "Instance Detach",
          "SUCCESS",
          null,
          `"${task.name}" · Batch Verified`
        );
      },

    onRejected:
      async (task, tx) => {

        stats.rejectedInstances++;
        stats.preservedAreas++;


        const restored =
          findByPluginData(
            state.root,
            PD_TASK_ID,
            task.marker
          );


        if (restored) {
          setPD(
            restored,
            PD_SKIP_DETACH,
            "1"
          );
        }


        addReport(
          stats,
          "Instance Detach",
          "REJECTED",
          restored,
          tx.reason === "visual-changed"
            ? "Detach 시 Render 변경"
            : tx.reason
        );
      },

    onSkipped:
      async () => {}
  });
}


/* =========================================================
   SCREENSHOT
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
    safeRenderBounds(container);


  if (
    !bounds ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    return {
      root,
      changed: false,
      reason: "invalid-render-bounds"
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
      changed: false,
      reason: "index-invalid"
    };
  }


  const bytes =
    await container.exportAsync({
      format: "PNG",

      constraint: {
        type: "SCALE",
        value: 1
      }
    });


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
      type: "IMAGE",
      scaleMode: "FILL",
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
        [1, 0, bounds.x],
        [0, 1, bounds.y]
      ],
      parent
    );


  safeRemove(
    container
  );


  return {
    root,
    changed: true,
    reason: "screenshot-created"
  };
}


async function processScreenshotTasks(
  state,
  tasks,
  stats
) {
  await processBatchWithIsolation({
    state,
    tasks,
    stats,

    applyTask:
      async (root, task) => {

        const node =
          findByPluginData(
            root,
            PD_TASK_ID,
            task.marker
          );


        if (!node) {
          return {
            root,
            changed: false,
            reason: "container-missing"
          };
        }


        return await replaceWithScreenshot(
          root,
          node
        );
      },

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
      async (task, tx) => {

        stats.screenshotRejected++;
        stats.preservedAreas++;


        const restored =
          findByPluginData(
            state.root,
            PD_TASK_ID,
            task.marker
          );


        if (restored) {
          setPD(
            restored,
            PD_SKIP_SCREENSHOT,
            "1"
          );
        }


        addReport(
          stats,
          "Mask / Clip",
          "REJECTED",
          restored,
          tx.reason === "visual-changed"
            ? "Screenshot 변환 시 Render 변경"
            : tx.reason
        );
      },

    onSkipped:
      async () => {}
  });
}


/* =========================================================
   GEOMETRY
========================================================= */

function captureDirectChildGeometry(
  node
) {
  const result =
    [];


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

      x:
        box.x,

      y:
        box.y,

      width:
        box.width,

      height:
        box.height
    });
  }


  return result;
}


function geometryMatches(
  snapshot
) {
  for (
    const before of
    snapshot
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
   FLATTEN CANDIDATE
========================================================= */

function isFlattenCandidate(node) {
  if (!isAlive(node)) {
    return false;
  }


  const type =
    safeType(node);


  if (
    type !== "FRAME" &&
    type !== "GROUP" &&
    type !== "COMPONENT"
  ) {
    return false;
  }


  if (
    containsMask(node) ||
    actuallyClipsChildren(node)
  ) {
    return false;
  }


  return (
    getPD(
      node,
      PD_SKIP_FLATTEN
    ) !== "1"
  );
}


/* =========================================================
   FAST FLATTEN
========================================================= */

function isFastFlattenCandidate(node) {
  if (!isAlive(node)) {
    return false;
  }


  const type =
    safeType(node);


  /*
   * Component는 Fast path 사용 금지.
   */
  if (
    type !== "GROUP" &&
    type !== "FRAME"
  ) {
    return false;
  }


  /*
   * Container 자신의 Auto Layout
   */
  if (
    isAutoLayout(node)
  ) {
    return false;
  }


  /*
   * Parent Auto Layout Flow
   */
  if (
    participatesInAutoLayout(node)
  ) {
    return false;
  }


  if (
    containsMask(node) ||
    actuallyClipsChildren(node)
  ) {
    return false;
  }


  /*
   * Container 자체 시각 요소 없음
   */
  if (
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
      Math.abs(node.rotation) >
        0.001
    ) {
      return false;
    }
  } catch (_) {}


  try {
    if (
      "blendMode" in node &&
      node.blendMode !== "PASS_THROUGH" &&
      node.blendMode !== "NORMAL"
    ) {
      return false;
    }
  } catch (_) {}


  return true;
}


/* =========================================================
   FAST FLATTEN ONE

   Root PNG 없음.
   전체 Root Clone 없음.

   Container local backup + Geometry만 검사.
========================================================= */

async function fastFlattenOne(
  state,
  task,
  stats
) {
  const container =
    findByPluginData(
      state.root,
      PD_TASK_ID,
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


  if (
    index < 0
  ) {
    return false;
  }


  const children =
    childrenOf(container);


  /*
   * Empty Container
   */
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


  for (
    const child of children
  ) {
    if (
      !await ensureSubtreeFontsLoaded(
        child
      )
    ) {
      return false;
    }
  }


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


  /*
   * Container local backup.
   */
  const originalRelativeTransform =
    container.relativeTransform;


  const backup =
    container.clone();


  figma.currentPage.appendChild(
    backup
  );


  backup.x +=
    CHECKPOINT_OFFSET_X;


  const moved =
    [];


  try {
    let insertion =
      index;


    for (
      const item of
      snapshots
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


    safeRemove(
      container
    );


    /*
     * 위치/크기 보존 검사
     */
    if (
      !geometryMatches(
        geometry
      )
    ) {
      throw new Error(
        "geometry-changed"
      );
    }


    safeRemove(
      backup
    );


    stats.fastFlatten++;
    stats.flattenedContainers++;
    stats.removedContainers++;
    stats.movedLayers +=
      moved.length;


    return true;

  } catch (_) {

    /*
     * Fast path 실패 시 local 복구.
     */
    for (
      const child of
      moved
    ) {
      if (
        isAlive(child)
      ) {
        safeRemove(child);
      }
    }


    if (
      isAlive(backup)
    ) {
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

    safeRemove(rect);

    return null;
  }


  try {
    if (
      source.fills !== figma.mixed
    ) {
      rect.fills =
        source.fills;
    }
  } catch (_) {}


  try {
    if (
      source.strokes !== figma.mixed
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

    safeRemove(rect);

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


  if (
    index < 0
  ) {
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
        safeRemove(container),

      reason:
        "empty-container",

      moved:
        0,

      removed:
        1,

      shells:
        0
    };
  }


  for (
    const child of
    children
  ) {
    if (
      !await ensureSubtreeFontsLoaded(
        child
      )
    ) {
      return {
        root,
        changed: false,
        reason: "font-unavailable"
      };
    }
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
      changed: false,
      reason: "transform-unavailable"
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
      insertion++;
      shells++;
    }
  }


  let moved =
    0;


  for (
    const item of
    snapshots
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

    reason:
      "flattened",

    moved,

    removed:
      1,

    shells
  };
}


/* =========================================================
   PROCESS FLATTEN PLAN
========================================================= */

async function processFlattenPlan(
  state,
  plan,
  stats
) {
  /* -------------------------------------------------------
     FAST CANDIDATES
     ------------------------------------------------------- */

  const failedFast =
    [];


  for (
    const task of
    plan.fastFlatten
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

    } else {
      /*
       * Fast path가 실패해도 포기하지 않는다.
       * 위험 Batch로 넘긴다.
       */
      failedFast.push(
        task
      );
    }
  }


  const risky =
    [
      ...failedFast,
      ...plan.riskyFlatten
    ];


  /*
   * 깊은 Container 먼저.
   */
  risky.sort(
    (a, b) =>
      b.depth -
      a.depth
  );


  /* -------------------------------------------------------
     VISUAL BATCH
     ------------------------------------------------------- */

  await processBatchWithIsolation({
    state,
    tasks:
      risky,
    stats,

    applyTask:
      async (root, task) => {

        const node =
          findByPluginData(
            root,
            PD_TASK_ID,
            task.marker
          );


        if (!node) {
          return {
            root,
            changed: false,
            reason: "container-missing"
          };
        }


        return await flattenContainerOneLevel(
          root,
          node
        );
      },

    onAccepted:
      async (task, result) => {

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
      async (task, tx) => {

        stats.flattenRejected++;
        stats.preservedAreas++;


        const restored =
          findByPluginData(
            state.root,
            PD_TASK_ID,
            task.marker
          );


        if (restored) {
          setPD(
            restored,
            PD_SKIP_FLATTEN,
            "1"
          );
        }


        addReport(
          stats,
          "Container Flatten",
          "REJECTED",
          restored,
          tx.reason === "visual-changed"
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
  if (
    safeType(root) === "FRAME"
  ) {
    return {
      root,
      changed: false,
      reason: "already-frame"
    };
  }


  if (
    safeType(root) === "INSTANCE"
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
      }
    } catch (_) {
      return {
        root,
        changed: false,
        reason: "root-instance-detach-failed"
      };
    }
  }


  if (
    safeType(root) === "FRAME"
  ) {
    return {
      root,
      changed: true,
      reason: "root-instance-detached"
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
      reason: "root-not-page-child"
    };
  }


  const index =
    parent.children.indexOf(
      root
    );


  const transform =
    safeTransform(root);


  if (!transform) {
    return {
      root,
      changed: false,
      reason: "transform-unavailable"
    };
  }


  const children =
    childrenOf(root);


  for (
    const child of
    children
  ) {
    if (
      !await ensureSubtreeFontsLoaded(
        child
      )
    ) {
      return {
        root,
        changed: false,
        reason: "font-unavailable"
      };
    }
  }


  const snapshots =
    children.map(
      child => ({
        child,

        transform:
          safeTransform(child)
      })
    );


  const frame =
    figma.createFrame();


  frame.name =
    "frame";


  frame.fills =
    [];


  frame.clipsContent =
    false;


  try {
    frame.layoutMode =
      "NONE";
  } catch (_) {}


  frame.resize(
    Math.max(root.width, 0.01),
    Math.max(root.height, 0.01)
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
    frame.effects =
      root.effects;
  } catch (_) {}


  try {
    frame.opacity =
      root.opacity;
  } catch (_) {}


  for (
    const item of
    snapshots
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


  safeRemove(
    root
  );


  return {
    root: frame,
    changed: true,
    reason: "converted-to-frame"
  };
}


/* =========================================================
   SINGLE VISUAL TRANSACTION
   Root Conversion / Ordering처럼 1회 작업용
========================================================= */

async function runSingleVisualTransaction(
  state,
  mutate,
  stats
) {
  const fakeTask = {
    marker:
      createTaskMarker(
        "single"
      )
  };


  const tx =
    await runVisualBatchTransaction(
      state,
      [fakeTask],

      async root =>
        await mutate(root),

      stats
    );


  return tx;
}


async function processRootConversion(
  state,
  stats
) {
  if (
    safeType(state.root) === "FRAME"
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

  } else if (tx.attempted) {
    stats.rootConversionRejected++;
    stats.preservedAreas++;
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
      sourceStyle || ""
    )
      .toLowerCase()
      .replace(
        /[_-]/g,
        " "
      );


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
  if (
    loadedInterStyles.has(
      style
    )
  ) {
    return style;
  }


  try {
    await figma.loadFontAsync({
      family: "Inter",
      style
    });


    loadedInterStyles.add(
      style
    );


    return style;

  } catch (_) {}


  try {
    await figma.loadFontAsync({
      family: "Inter",
      style: "Regular"
    });


    loadedInterStyles.add(
      "Regular"
    );


    return "Regular";

  } catch (_) {
    return null;
  }
}


async function convertTextNodeToInter(
  node
) {
  if (
    safeType(node) !== "TEXT"
  ) {
    return 0;
  }


  if (
    !await ensureTextFontsLoaded(
      node
    )
  ) {
    return 0;
  }


  try {
    const segments =
      node.getStyledTextSegments(
        ["fontName"]
      );


    let converted =
      0;


    for (
      const segment of
      segments
    ) {
      const oldStyle =
        segment.fontName &&
        segment.fontName !== figma.mixed
          ? segment.fontName.style
          : "Regular";


      const newStyle =
        await loadInterStyle(
          mapInterStyle(
            oldStyle
          )
        );


      if (!newStyle) {
        continue;
      }


      if (
        segment.fontName &&
        segment.fontName !== figma.mixed &&
        segment.fontName.family === "Inter" &&
        segment.fontName.style === newStyle
      ) {
        continue;
      }


      node.setRangeFontName(
        segment.start,
        segment.end,
        {
          family: "Inter",
          style: newStyle
        }
      );


      converted++;
    }


    return converted;

  } catch (_) {
    return 0;
  }
}


/* =========================================================
   FONT BATCH
========================================================= */

async function processTextTasks(
  state,
  tasks,
  stats
) {
  if (
    !convertFontToInter ||
    tasks.length === 0
  ) {
    return;
  }


  await processBatchWithIsolation({
    state,
    tasks,
    stats,

    applyTask:
      async (root, task) => {

        const text =
          findByPluginData(
            root,
            PD_TASK_ID,
            task.marker
          );


        if (
          !text ||
          safeType(text) !== "TEXT"
        ) {
          return {
            root,
            changed: false,
            reason: "text-missing"
          };
        }


        const count =
          await convertTextNodeToInter(
            text
          );


        setPD(
          text,
          PD_INTER_DONE,
          "1"
        );


        return {
          root,

          changed:
            count > 0,

          converted:
            count,

          reason:
            count > 0
              ? "font-converted"
              : "already-inter-or-unavailable"
        };
      },

    onAccepted:
      async (task, result) => {

        stats.convertedTexts++;

        stats.convertedFontSegments +=
          result.converted || 0;


        addReport(
          stats,
          "Font → Inter",
          "SUCCESS",
          null,
          `"${task.name}"`
        );
      },

    onRejected:
      async (task, tx) => {

        stats.failedFontConversions++;


        const restored =
          findByPluginData(
            state.root,
            PD_TASK_ID,
            task.marker
          );


        if (restored) {
          setPD(
            restored,
            PD_INTER_DONE,
            "1"
          );
        }


        addReport(
          stats,
          "Font → Inter",
          "REJECTED",
          restored,
          tx.reason === "visual-changed"
            ? "Inter 변경 시 Render 차이"
            : tx.reason
        );
      },

    onSkipped:
      async (task) => {

        const node =
          findByPluginData(
            state.root,
            PD_TASK_ID,
            task.marker
          );


        if (node) {
          setPD(
            node,
            PD_INTER_DONE,
            "1"
          );
        }
      }
  });
}


/* =========================================================
   NAMING
========================================================= */

function looksLikeScreenshotName(name) {
  const value =
    String(
      name || ""
    )
      .toLowerCase();


  return (
    value.includes("screenshot") ||
    value.includes("screen shot") ||
    value.includes("스크린샷")
  );
}


function looksLikeIconName(name) {
  const value =
    String(
      name || ""
    )
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
  const type =
    safeType(node);


  if (
    looksLikeIconName(
      safeName(node)
    )
  ) {
    return true;
  }


  return (
    type === "VECTOR" ||
    type === "BOOLEAN_OPERATION" ||
    type === "POLYGON" ||
    type === "STAR"
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
    type === "RECTANGLE" ||
    type === "VECTOR"
  ) {
    if (
      hasImageFill(node)
    ) {
      return false;
    }


    try {
      if (
        node.width >= 8 &&
        node.height <= 2
      ) {
        return true;
      }


      if (
        node.height >= 8 &&
        node.width <= 2
      ) {
        return true;
      }
    } catch (_) {}
  }


  return false;
}


function looksLikeScreenshot(
  node,
  root
) {
  if (
    safeType(node) !== "RECTANGLE" ||
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
      node.width / root.width >= 0.7 &&
      node.height / root.height >= 0.5
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


function desiredLayerName(
  node,
  root
) {
  const type =
    safeType(node);


  const current =
    safeName(node);


  /*
   * LID 보호
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
    return renameTextToHyphen
      ? "-"
      : current;
  }


  /*
   * Image / Screenshot
   */
  if (
    type === "RECTANGLE" &&
    hasImageFill(node)
  ) {
    return looksLikeScreenshot(
      node,
      root
    )
      ? "screenshot"
      : "image";
  }


  /*
   * Line 먼저.
   */
  if (
    looksLikeLine(node)
  ) {
    return "line";
  }


  /*
   * Icon
   */
  if (
    looksLikeIcon(node)
  ) {
    return "icon";
  }


  /*
   * Shape
   */
  if (
    isShapeNode(node)
  ) {
    return "shape";
  }


  if (
    type === "GROUP"
  ) {
    return "group";
  }


  if (
    type === "FRAME"
  ) {
    return looksLikeIPhone(node)
      ? "iphone"
      : "frame";
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
   LAYER ORDER
========================================================= */

function getOrderBounds(node) {
  const box =
    safeBounds(node);


  if (!box) {
    return null;
  }


  return {
    x:
      box.x,

    y:
      box.y,

    width:
      box.width,

    height:
      box.height,

    right:
      box.x + box.width,

    bottom:
      box.y + box.height
  };
}


function isSameVisualRow(
  a,
  b
) {
  if (
    !a ||
    !b
  ) {
    return false;
  }


  if (
    Math.abs(
      a.y -
      b.y
    ) <= ROW_Y_TOLERANCE
  ) {
    return true;
  }


  const overlapTop =
    Math.max(
      a.y,
      b.y
    );


  const overlapBottom =
    Math.min(
      a.bottom,
      b.bottom
    );


  const overlap =
    overlapBottom -
    overlapTop;


  if (
    overlap <= 0
  ) {
    return false;
  }


  const minHeight =
    Math.min(
      a.height,
      b.height
    );


  return (
    minHeight > 0 &&
    overlap >=
      minHeight * 0.5
  );
}


function boundsOverlap(
  a,
  b
) {
  if (
    !a ||
    !b
  ) {
    return false;
  }


  return !(
    a.right <= b.x ||
    b.right <= a.x ||
    a.bottom <= b.y ||
    b.bottom <= a.y
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


          if (
            Math.abs(dy) >
              ROW_Y_TOLERANCE
          ) {
            return dy;
          }


          return (
            a.bounds.x -
            b.bounds.x
          );
        }
      );


  const rows =
    [];


  for (
    const item of
    sorted
  ) {
    if (!item.bounds) {
      rows.push({
        y: Infinity,
        items: [item]
      });

      continue;
    }


    let row =
      null;


    for (
      const candidate of
      rows
    ) {
      if (
        candidate.items.some(
          current =>
            current.bounds &&
            isSameVisualRow(
              current.bounds,
              item.bounds
            )
        )
      ) {
        row =
          candidate;

        break;
      }
    }


    if (!row) {
      row = {
        y:
          item.bounds.y,

        items:
          []
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


  /*
   * 위 → 아래
   */
  rows.sort(
    (a, b) =>
      a.y -
      b.y
  );


  /*
   * 같은 줄 좌 → 우
   */
  for (
    const row of
    rows
  ) {
    row.items.sort(
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


        const dx =
          a.bounds.x -
          b.bounds.x;


        if (
          Math.abs(dx) >
          0.1
        ) {
          return dx;
        }


        const dy =
          a.bounds.y -
          b.bounds.y;


        if (
          Math.abs(dy) >
          0.1
        ) {
          return dy;
        }


        return (
          a.originalPanelIndex -
          b.originalPanelIndex
        );
      }
    );
  }


  return rows;
}


function buildSafeDesiredPanelOrder(root) {
  const children =
    childrenOf(root);


  /*
   * Layer panel 표시 순서는
   * children 역순.
   */
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

        desiredRank:
          0,

        outgoing:
          new Set(),

        indegree:
          0
      })
    );


  const rows =
    buildVisualRows(
      items
    );


  const visual =
    [];


  for (
    const row of rows
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
   * 실제 겹치는 Layer는
   * 기존 Z-order를 Constraint로 유지.
   */
  for (
    let i = 0;
    i < items.length;
    i++
  ) {
    for (
      let j = i + 1;
      j < items.length;
      j++
    ) {
      if (
        boundsOverlap(
          items[i].bounds,
          items[j].bounds
        )
      ) {
        items[i].outgoing.add(
          items[j]
        );


        items[j].indegree++;
      }
    }
  }


  const available =
    items.filter(
      item =>
        item.indegree === 0
    );


  const output =
    [];


  while (
    available.length > 0
  ) {
    available.sort(
      (a, b) => {

        const rankDiff =
          a.desiredRank -
          b.desiredRank;


        if (
          rankDiff !== 0
        ) {
          return rankDiff;
        }


        return (
          a.originalPanelIndex -
          b.originalPanelIndex
        );
      }
    );


    const current =
      available.shift();


    output.push(
      current
    );


    for (
      const next of
      current.outgoing
    ) {
      next.indegree--;


      if (
        next.indegree === 0
      ) {
        available.push(
          next
        );
      }
    }
  }


  if (
    output.length !==
    items.length
  ) {
    return null;
  }


  return output;
}


async function reorderRootLayers(root) {
  if (
    !isAlive(root)
  ) {
    return {
      root,
      changed: false,
      reason: "root-missing"
    };
  }


  /*
   * Root Auto Layout에서는
   * Child order가 실제 위치를 바꾼다.
   */
  if (
    isAutoLayout(root)
  ) {
    return {
      root,
      changed: false,
      reason: "root-auto-layout"
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


  let changed =
    false;


  for (
    let i = 0;
    i < children.length;
    i++
  ) {
    if (
      children[i] !==
      desiredChildren[i]
    ) {
      changed =
        true;

      break;
    }
  }


  if (!changed) {
    return {
      root,
      changed: false,
      reason: "already-ordered"
    };
  }


  for (
    let i = 0;
    i < desiredChildren.length;
    i++
  ) {
    const node =
      desiredChildren[i];


    if (
      isAlive(node)
    ) {
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


async function processOrder(
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
    tx.accepted
  ) {
    stats.orderChanged++;


    addReport(
      stats,
      "Layer Order",
      "SUCCESS",
      state.root,
      "Top → Bottom / Left → Right"
    );

  } else if (
    tx.attempted
  ) {
    stats.orderRejected++;


    addReport(
      stats,
      "Layer Order",
      "REJECTED",
      state.root,
      tx.reason === "visual-changed"
        ? "Z-order 변경 감지 · 기존 순서 유지"
        : tx.reason
    );
  }
}


/* =========================================================
   ANALYZE
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

    containers:
      0,

    instances:
      0,

    autoLayouts:
      0,

    masks:
      0,

    clips:
      0,

    text:
      0,

    nonInterText:
      0,

    icons:
      0,

    lines:
      0,

    bakeCandidates:
      0
  };


  function walk(node) {
    if (!isAlive(node)) {
      return;
    }


    if (
      isContainer(node) &&
      node !== root
    ) {
      result.containers++;
    }


    if (
      safeType(node) === "INSTANCE"
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
      safeType(node) === "TEXT"
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
              !segment.fontName ||
              segment.fontName === figma.mixed ||
              segment.fontName.family !== "Inter"
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
    safeType(parent) !== "PAGE"
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


  if (!isAlive(originalRoot)) {
    return {
      success: false,
      root:
        originalRoot,
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
    safeType(parent) !== "PAGE"
  ) {
    return {
      success: false,
      root:
        originalRoot,
      stats,
      fatalReason:
        "Screen must be a direct Page child."
    };
  }


  /* =====================================================
     WORKING COPY
  ===================================================== */

  let state;


  try {
    state =
      await createWorkingState(
        originalRoot
      );

  } catch (error) {
    return {
      success: false,
      root:
        originalRoot,
      stats,
      fatalReason:
        error.message ||
        String(error)
    };
  }


  /* =====================================================
     1. GARBAGE
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
     2. ROOT → FRAME
  ===================================================== */

  await processRootConversion(
    state,
    stats
  );


  /* =====================================================
     3. PLAN #1
     Tree 전체 Scan
  ===================================================== */

  let plan =
    buildExecutionPlan(
      state.root,
      stats
    );


  /* =====================================================
     4. INSTANCE DETACH
     Batch + Binary
  ===================================================== */

  for (
    let round = 0;
    round < MAX_INSTANCE_ROUNDS;
    round++
  ) {
    if (
      plan.instances.length === 0
    ) {
      break;
    }


    await processInstanceTasks(
      state,
      plan.instances,
      stats
    );


    /*
     * Instance를 Detach했을 때만
     * 내부 Layer가 새롭게 탐색 가능해지므로
     * Plan을 한 번 갱신한다.
     */
    if (
      round <
      MAX_INSTANCE_ROUNDS - 1
    ) {
      plan =
        buildExecutionPlan(
          state.root,
          stats
        );
    }
  }


  /* =====================================================
     5. FINAL STRUCTURE PLAN
     Instance 이후 딱 한 번 재탐색
  ===================================================== */

  plan =
    buildExecutionPlan(
      state.root,
      stats
    );


  /* =====================================================
     6. MASK / CLIP
     Batch + Binary
  ===================================================== */

  await processScreenshotTasks(
    state,
    plan.screenshots,
    stats
  );


  /* =====================================================
     7. FLATTEN
     Fast Geometry +
     Batch / Binary
  ===================================================== */

  await processFlattenPlan(
    state,
    plan,
    stats
  );


  /* =====================================================
     8. FONT
     선택된 경우만 Batch + Binary
  ===================================================== */

  await processTextTasks(
    state,
    plan.texts,
    stats
  );


  /* =====================================================
     9. NAMING
     PNG 검사 없음
  ===================================================== */

  processNaming(
    state.root,
    stats
  );


  addReport(
    stats,
    "Layer Naming",
    "SUCCESS",
    state.root,
    `${stats.renamedLayers} layers renamed`
  );


  /* =====================================================
     10. ORDER
     Visual check 딱 1회
  ===================================================== */

  await processOrder(
    state,
    stats
  );


  /* =====================================================
     11. INTERNAL DATA CLEAN
  ===================================================== */

  clearInternalPluginData(
    state.root
  );


  /* =====================================================
     12. COMMIT
  ===================================================== */

  const committed =
    commitWorkingRoot(
      originalRoot,
      state.root
    );


  if (!committed) {
    safeRemove(
      state.root
    );


    return {
      success: false,

      root:
        originalRoot,

      stats,

      fatalReason:
        "Commit failed"
    };
  }


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
}


/* =========================================================
   ANALYZED ROOTS
========================================================= */

async function getAnalyzedRoots() {
  const result =
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
        result.push(node);
      }

    } catch (_) {}
  }


  return result;
}


/* =========================================================
   UI MESSAGES
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
     GARBAGE VIEW
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


      /*
       * Selection이 바뀌어도
       * analyzedRootIds는 유지.
       */
      figma.currentPage.selection =
        [node];


      figma.viewport
        .scrollAndZoomIntoView(
          [node]
        );

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
      ].filter(
        node =>
          isAlive(node)
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
          node =>
            safeId(node)
        )
        .filter(Boolean);


    const results =
      selection.map(
        root => ({
          name:
            safeName(root),

          rootType:
            safeType(root),

          willConvertToFrame:
            safeType(root) !== "FRAME",

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
            node =>
              safeId(node)
          )
          .filter(Boolean);
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


    approvedGarbageIds =
      new Set(
        msg.garbageIds ||
        []
      );


    renameTextToHyphen =
      msg.renameTextToHyphen === true;


    convertFontToInter =
      msg.convertFontToInter === true;


    figma.ui.postMessage({
      type: "processing"
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
      binarySplits: 0,

      report: [],

      failureReasons: []
    };


    for (
      const root of
      roots
    ) {
      try {
        const result =
          await processRoot(
            root
          );


        if (
          result.root &&
          isAlive(
            result.root
          )
        ) {
          resultRoots.push(
            result.root
          );
        }


        if (
          result.success
        ) {
          total.committed++;

        } else {
          total.rolledBack++;


          if (
            result.fatalReason
          ) {
            total.failureReasons.push({
              screen:
                safeName(root),

              reason:
                result.fatalReason
            });
          }
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
            typeof total[key] === "number"
          ) {
            total[key] +=
              result.stats[key];
          }
        }

      } catch (error) {
        total.rolledBack++;


        total.failureReasons.push({
          screen:
            safeName(root),

          reason:
            error &&
            error.message
              ? error.message
              : String(error)
        });


        if (
          isAlive(root)
        ) {
          resultRoots.push(root);
        }
      }
    }


    const aliveRoots =
      resultRoots.filter(
        root =>
          isAlive(root)
      );


    if (
      aliveRoots.length > 0
    ) {
      figma.currentPage.selection =
        aliveRoots;


      figma.viewport
        .scrollAndZoomIntoView(
          aliveRoots
        );


      analyzedRootIds =
        aliveRoots
          .map(
            root =>
              safeId(root)
          )
          .filter(Boolean);
    }


    /* =====================================================
       COMPLETE
    ===================================================== */

    figma.ui.postMessage({
      type: "complete",
      result: total
    });


    /* =====================================================
       PERFORMANCE REPORT
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
      "Fast Flatten:",
      total.fastFlatten
    );


    console.log(
      "Flattened:",
      total.flattenedContainers
    );


    console.log(
      "Detached Instances:",
      total.detachedInstances
    );


    console.log(
      "Preserved Instances:",
      total.rejectedInstances
    );


    console.log(
      "Screenshot Bake:",
      total.screenshotBaked
    );


    console.log(
      "Renamed Layers:",
      total.renamedLayers
    );


    console.log(
      "Layer Order:",
      total.orderChanged
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
      total.failureReasons.length > 0
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
        `Cleanup 완료 · Garbage ${total.removedGarbage} · Flatten ${total.flattenedContainers} · Batch Check ${total.visualBatchChecks}`
      );

    } else {
      figma.notify(
        `Cleanup 완료 · ${total.committed}개 적용 / ${total.rolledBack}개 원본 유지`
      );
    }


    return;
  }
};
