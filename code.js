figma.showUI(__html__, {
  width: 440,
  height: 760,
  themeColors: true
});


/* =========================================================
   SCREEN LAYER CLEANER
   FAST + SAFE VERSION

   제1법칙
   ---------------------------------------------------------
   디자인 화면은 변경하지 않는다.

   전략
   ---------------------------------------------------------
   FAST SAFE
   - 확실한 Garbage
   - 단순 Group / Frame
   - Naming
   → PNG 검사 생략

   GEOMETRY SAFE
   - 단순 Container Flatten
   → 절대 좌표 / 크기 비교

   VISUAL SAFE
   - Instance
   - Auto Layout
   - Mask / Clip
   - 애매한 Container
   - Layer Order
   - Font
   → PNG Before / After 검증

========================================================= */


/* =========================================================
   GLOBAL
========================================================= */

let renameTextToHyphen = false;
let convertFontToInter = false;

let approvedGarbageIds = new Set();
let analyzedRootIds = [];

const WORK_OFFSET_X = 30000;
const CHECKPOINT_OFFSET_X = 60000;

const ROW_Y_TOLERANCE = 6;
const GEOMETRY_TOLERANCE = 0.25;

const MAX_INSTANCE_PASSES = 8;
const MAX_SCREENSHOT_PASSES = 8;
const MAX_FLATTEN_PASSES = 20;


/* =========================================================
   INTERNAL PLUGIN DATA
========================================================= */

const PD_GARBAGE_ID = "slc_garbage_id";
const PD_CURRENT_OP = "slc_current_op";

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
   NODE TYPES
========================================================= */

function isContainer(node) {
  const type = safeType(node);

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
  const parent = safeParent(node);

  if (!parent || !isAutoLayout(parent)) {
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

  if (
    Math.abs(det) <
    0.000001
  ) {
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
  if (!isAlive(node)) {
    return "";
  }

  try {
    return node.getPluginData(key) || "";
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


function clearInternalPluginData(root) {
  const keys = [
    PD_GARBAGE_ID,
    PD_CURRENT_OP,
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
   ORIGINAL → CLONE PATH
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

    const id = safeId(node);

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
        [
          ...path,
          i
        ]
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
   PNG VISUAL CHECK
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
  if (!a || !b) {
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
      a[i] !== b[i]
    ) {
      return false;
    }
  }

  return true;
}


/* =========================================================
   WORKING STATE
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
   VISUAL TRANSACTION
   위험한 작업에만 사용
========================================================= */

async function runVisualTransaction(
  state,
  mutate
) {
  if (
    !state ||
    !isAlive(state.root)
  ) {
    return {
      accepted: false,
      attempted: false,
      reason: "working-root-missing"
    };
  }

  const currentRoot =
    state.root;

  const before =
    await exportNodePng(
      currentRoot
    );

  if (!before) {
    return {
      accepted: false,
      attempted: false,
      reason: "before-render-failed"
    };
  }

  const rootX =
    currentRoot.x;

  const rootY =
    currentRoot.y;

  let checkpoint = null;

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

  } catch (_) {
    return {
      accepted: false,
      attempted: false,
      reason: "checkpoint-create-failed"
    };
  }

  let mutationResult;

  try {
    mutationResult =
      await mutate(
        currentRoot
      );

  } catch (error) {
    if (
      state.root &&
      isAlive(state.root)
    ) {
      safeRemove(
        state.root
      );
    }

    checkpoint.x = rootX;
    checkpoint.y = rootY;

    state.root =
      checkpoint;

    return {
      accepted: false,
      attempted: true,
      reason: "operation-error",
      error
    };
  }

  if (
    mutationResult &&
    mutationResult.root &&
    isAlive(
      mutationResult.root
    )
  ) {
    state.root =
      mutationResult.root;
  }

  const changed =
    !!(
      mutationResult &&
      mutationResult.changed
    );

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

    checkpoint.x = rootX;
    checkpoint.y = rootY;

    state.root =
      checkpoint;

    return {
      accepted: false,
      attempted: true,
      reason: "after-render-failed",
      data: mutationResult
    };
  }

  const same =
    sameBytes(
      before,
      after
    );

  if (
    !changed &&
    same
  ) {
    safeRemove(checkpoint);

    return {
      accepted: false,
      attempted: false,
      reason:
        mutationResult &&
        mutationResult.reason
          ? mutationResult.reason
          : "no-change",
      data: mutationResult
    };
  }

  if (
    changed &&
    same
  ) {
    safeRemove(checkpoint);

    return {
      accepted: true,
      attempted: true,
      reason: "visual-identical",
      data: mutationResult
    };
  }

  /*
   * 실패 → 해당 작업만 복구
   */
  if (
    state.root &&
    isAlive(state.root)
  ) {
    safeRemove(
      state.root
    );
  }

  checkpoint.x = rootX;
  checkpoint.y = rootY;

  state.root =
    checkpoint;

  return {
    accepted: false,
    attempted: true,
    reason:
      changed
        ? "visual-changed"
        : "unexpected-mutation",
    data: mutationResult
  };
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
   PAINT / EFFECT HELPERS
========================================================= */

function hasVisiblePaint(paints) {
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
        typeof paint.opacity ===
          "number" &&
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
      node.fills ===
        figma.mixed ||
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
      node.strokes ===
        figma.mixed ||
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
      node.fills ===
        figma.mixed ||
      !Array.isArray(
        node.fills
      )
    ) {
      return false;
    }

    return node.fills.some(
      fill =>
        fill.type ===
          "IMAGE" &&
        fill.visible !==
          false
    );

  } catch (_) {
    return false;
  }
}


/* =========================================================
   MASK
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


/* =========================================================
   CLIP
========================================================= */

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

  const left = box.x;
  const top = box.y;

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
        left - 0.5 ||

      childBox.y <
        top - 0.5 ||

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
   GARBAGE DETECTION
========================================================= */

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
  if (
    !isContainer(node)
  ) {
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

  const n =
    safeRenderBounds(node);

  const r =
    safeBounds(root);

  if (!n || !r) {
    return false;
  }

  const nr =
    n.x + n.width;

  const nb =
    n.y + n.height;

  const rr =
    r.x + r.width;

  const rb =
    r.y + r.height;

  return (
    nr <= r.x ||
    n.x >= rr ||
    nb <= r.y ||
    n.y >= rb
  );
}


function getGarbageReason(
  node,
  root
) {
  if (!isAlive(node)) {
    return null;
  }

  /*
   * Root 자체는 Garbage 금지.
   */
  if (
    node === root
  ) {
    return null;
  }

  /* Hidden */
  try {
    if (
      "visible" in node &&
      node.visible === false
    ) {
      return "Hidden · visible=false";
    }
  } catch (_) {}


  /* Transparent */
  try {
    if (
      "opacity" in node &&
      node.opacity === 0
    ) {
      return "Transparent · opacity=0";
    }
  } catch (_) {}


  /* Slice */
  if (
    safeType(node) ===
    "SLICE"
  ) {
    return "Slice";
  }


  /* Tiny */
  if (
    isTinyNode(node)
  ) {
    return "Zero / Tiny Size";
  }


  /* Empty Shape */
  if (
    isEmptyVisualShape(node)
  ) {
    return "Empty Shape";
  }


  /* Empty Container */
  if (
    isEmptyContainer(node)
  ) {
    return "Empty Container";
  }


  /* Outside Screen */
  if (
    root &&
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
    node === root
  ) {
    return false;
  }


  /*
   * Mask는 무조건 제외.
   */
  if (
    isMaskNode(node)
  ) {
    return false;
  }


  /*
   * Auto Layout flow item은 삭제하면
   * 형제 위치가 변할 수 있음.
   */
  if (
    participatesInAutoLayout(node)
  ) {
    return false;
  }


  /*
   * Hidden
   */
  try {
    if (
      "visible" in node &&
      node.visible === false
    ) {
      return true;
    }
  } catch (_) {}


  /*
   * 완전히 빈 Shape
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
   * Screen 바깥 + Root가 Clip.
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
   GARBAGE ANALYSIS
========================================================= */

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
          safeId(node) || "",

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


  walk(root, "");

  return result;
}


/* =========================================================
   MARK GARBAGE ON CLONE
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
   PROCESS GARBAGE
========================================================= */

async function processGarbage(
  state,
  stats
) {
  while (true) {
    let target = null;
    let shallowest =
      Infinity;


    function walk(
      node,
      depth
    ) {
      if (!isAlive(node)) {
        return;
      }

      if (
        getPD(
          node,
          PD_GARBAGE_ID
        ) &&
        getGarbageReason(
          node,
          state.root
        ) &&
        depth < shallowest
      ) {
        target = node;
        shallowest = depth;
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
      state.root,
      0
    );


    if (!target) {
      break;
    }


    const markerId =
      getPD(
        target,
        PD_GARBAGE_ID
      );

    const name =
      safeName(target);

    const type =
      safeType(target);

    const reason =
      getGarbageReason(
        target,
        state.root
      );


    /* =====================================================
       FAST PATH
    ===================================================== */

    if (
      isFastSafeGarbage(
        target,
        state.root
      )
    ) {
      if (
        safeRemove(target)
      ) {
        stats.removedGarbage++;
        stats.fastGarbage++;

        addReport(
          stats,
          "Garbage Delete",
          "SUCCESS",
          null,
          `${type} "${name}" · ${reason} · Fast Safe`
        );

        continue;
      }
    }


    /* =====================================================
       VISUAL PATH
    ===================================================== */

    const marker =
      `garbage_${Date.now()}_${Math.random()}`;


    setPD(
      target,
      PD_CURRENT_OP,
      marker
    );


    const tx =
      await runVisualTransaction(
        state,

        async root => {
          const node =
            findByPluginData(
              root,
              PD_CURRENT_OP,
              marker
            );

          if (!node) {
            return {
              root,
              changed: false,
              reason:
                "garbage-not-found"
            };
          }

          return {
            root,
            changed:
              safeRemove(node),
            reason:
              "garbage-delete"
          };
        }
      );


    if (
      tx.accepted
    ) {
      stats.removedGarbage++;

      addReport(
        stats,
        "Garbage Delete",
        "SUCCESS",
        null,
        `${type} "${name}" · ${reason} · Visual Verified`
      );

      continue;
    }


    stats.protectedGarbage++;


    const restored =
      findByPluginData(
        state.root,
        PD_GARBAGE_ID,
        markerId
      );


    if (restored) {
      setPD(
        restored,
        PD_GARBAGE_ID,
        ""
      );

      setPD(
        restored,
        PD_CURRENT_OP,
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
        ? `삭제 시 Render 변경 · ${reason}`
        : `삭제 실패 · ${tx.reason}`
    );
  }
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
    fontName ===
      figma.mixed
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


async function ensureTextFontsLoaded(
  node
) {
  if (
    safeType(node) !==
    "TEXT"
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
        segment.fontName ===
          figma.mixed
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


async function ensureSubtreeFontsLoaded(
  node
) {
  if (!isAlive(node)) {
    return false;
  }

  if (
    safeType(node) ===
    "TEXT"
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
   INSTANCE
========================================================= */

function collectInstances(root) {
  const result = [];


  function walk(
    node,
    depth
  ) {
    for (
      const child of
      childrenOf(node)
    ) {
      if (
        safeType(child) ===
          "INSTANCE" &&
        getPD(
          child,
          PD_SKIP_DETACH
        ) !== "1"
      ) {
        result.push({
          node: child,
          depth:
            depth + 1
        });
      }

      if (
        safeType(child) !==
        "INSTANCE"
      ) {
        walk(
          child,
          depth + 1
        );
      }
    }
  }


  walk(root, 0);

  result.sort(
    (a, b) =>
      b.depth -
      a.depth
  );

  return result;
}


async function processInstances(
  state,
  stats
) {
  for (
    let pass = 0;
    pass <
      MAX_INSTANCE_PASSES;
    pass++
  ) {
    const targets =
      collectInstances(
        state.root
      );

    if (
      targets.length === 0
    ) {
      break;
    }

    let changedAny = false;


    for (
      const item of
      targets
    ) {
      const node =
        item.node;

      if (!isAlive(node)) {
        continue;
      }

      const oldName =
        safeName(node);

      const marker =
        `detach_${Date.now()}_${Math.random()}`;

      setPD(
        node,
        PD_CURRENT_OP,
        marker
      );


      const tx =
        await runVisualTransaction(
          state,

          async root => {
            const instance =
              findByPluginData(
                root,
                PD_CURRENT_OP,
                marker
              );

            if (
              !instance ||
              safeType(instance) !==
                "INSTANCE"
            ) {
              return {
                root,
                changed: false,
                reason:
                  "instance-not-found"
              };
            }

            const detached =
              instance.detachInstance();

            return {
              root,
              changed:
                !!detached,
              reason:
                detached
                  ? "detached"
                  : "detach-failed"
            };
          }
        );


      if (
        tx.accepted
      ) {
        stats.detachedInstances++;
        changedAny = true;

        addReport(
          stats,
          "Instance Detach",
          "SUCCESS",
          null,
          `"${oldName}"`
        );

      } else if (
        tx.attempted
      ) {
        stats.rejectedInstances++;
        stats.preservedAreas++;

        const restored =
          findByPluginData(
            state.root,
            PD_CURRENT_OP,
            marker
          );

        if (restored) {
          setPD(
            restored,
            PD_SKIP_DETACH,
            "1"
          );

          setPD(
            restored,
            PD_CURRENT_OP,
            ""
          );
        }

        addReport(
          stats,
          "Instance Detach",
          "REJECTED",
          restored,
          tx.reason
        );
      }
    }


    if (!changedAny) {
      break;
    }
  }
}


/* =========================================================
   SCREENSHOT / MASK / CLIP
========================================================= */

function collectScreenshotCandidates(
  root
) {
  const result = [];

  function walk(
    node,
    depth
  ) {
    for (
      const child of
      childrenOf(node)
    ) {
      walk(
        child,
        depth + 1
      );

      if (
        isContainer(child) &&
        safeType(child) !==
          "INSTANCE" &&
        getPD(
          child,
          PD_SKIP_SCREENSHOT
        ) !== "1" &&
        (
          containsMask(child) ||
          actuallyClipsChildren(
            child
          )
        )
      ) {
        result.push({
          node: child,
          depth:
            depth + 1
        });
      }
    }
  }

  walk(root, 0);

  result.sort(
    (a, b) =>
      b.depth -
      a.depth
  );

  return result;
}


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
      reason:
        "invalid-parent"
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
    bounds.width,
    bounds.height
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

  safeRemove(container);

  return {
    root,
    changed: true,
    reason:
      "screenshot-created"
  };
}


async function processScreenshots(
  state,
  stats
) {
  for (
    let pass = 0;
    pass <
      MAX_SCREENSHOT_PASSES;
    pass++
  ) {
    const targets =
      collectScreenshotCandidates(
        state.root
      );

    if (
      targets.length === 0
    ) {
      break;
    }

    let changedAny = false;


    for (
      const item of
      targets
    ) {
      const node =
        item.node;

      if (!isAlive(node)) {
        continue;
      }

      const marker =
        `shot_${Date.now()}_${Math.random()}`;

      setPD(
        node,
        PD_CURRENT_OP,
        marker
      );

      const oldName =
        safeName(node);


      const tx =
        await runVisualTransaction(
          state,

          async root => {
            const current =
              findByPluginData(
                root,
                PD_CURRENT_OP,
                marker
              );

            if (!current) {
              return {
                root,
                changed: false,
                reason:
                  "container-not-found"
              };
            }

            return await replaceWithScreenshot(
              root,
              current
            );
          }
        );


      if (
        tx.accepted
      ) {
        stats.screenshotBaked++;
        stats.bakedAreas++;

        changedAny = true;

        addReport(
          stats,
          "Mask / Clip",
          "SUCCESS",
          null,
          `"${oldName}" → screenshot`
        );

      } else if (
        tx.attempted
      ) {
        stats.screenshotRejected++;
        stats.preservedAreas++;

        const restored =
          findByPluginData(
            state.root,
            PD_CURRENT_OP,
            marker
          );

        if (restored) {
          setPD(
            restored,
            PD_SKIP_SCREENSHOT,
            "1"
          );

          setPD(
            restored,
            PD_CURRENT_OP,
            ""
          );
        }
      }
    }


    if (!changedAny) {
      break;
    }
  }
}


/* =========================================================
   GEOMETRY SNAPSHOT
========================================================= */

function captureGeometry(node) {
  const result = [];


  function walk(current) {
    if (!isAlive(current)) {
      return;
    }

    const box =
      safeBounds(current);

    if (box) {
      result.push({
        node: current,
        x: box.x,
        y: box.y,
        width:
          box.width,
        height:
          box.height
      });
    }

    for (
      const child of
      childrenOf(current)
    ) {
      walk(child);
    }
  }


  for (
    const child of
    childrenOf(node)
  ) {
    walk(child);
  }

  return result;
}


function geometryMatches(
  snapshots
) {
  for (
    const before of
    snapshots
  ) {
    if (
      !isAlive(
        before.node
      )
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
   FAST FLATTEN CANDIDATE
========================================================= */

function isFastFlattenCandidate(
  node
) {
  if (!isAlive(node)) {
    return false;
  }

  const type =
    safeType(node);

  if (
    type !== "GROUP" &&
    type !== "FRAME"
  ) {
    return false;
  }

  if (
    isAutoLayout(node)
  ) {
    return false;
  }

  if (
    participatesInAutoLayout(
      node
    )
  ) {
    return false;
  }

  if (
    containsMask(node) ||
    actuallyClipsChildren(
      node
    )
  ) {
    return false;
  }

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
   LOCAL FAST FLATTEN
========================================================= */

async function fastFlattenContainer(
  container,
  stats
) {
  if (
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

  if (
    children.length === 0
  ) {
    return safeRemove(
      container
    );
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
      return false;
    }
  }


  const geometry =
    captureGeometry(
      container
    );


  const snapshots =
    children.map(
      child => ({
        child,
        transform:
          safeTransform(
            child
          )
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
   * Container만 Backup.
   * Root 전체 clone보다 훨씬 가볍다.
   */
  const backup =
    container.clone();

  figma.currentPage.appendChild(
    backup
  );

  backup.x +=
    CHECKPOINT_OFFSET_X;


  const moved = [];


  try {
    let insertIndex =
      index;

    for (
      const item of
      snapshots
    ) {
      parent.insertChild(
        insertIndex,
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

      insertIndex++;
    }


    safeRemove(
      container
    );


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
     * Local rollback
     */
    for (
      const child of moved
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
    }


    return false;
  }
}


/* =========================================================
   GENERAL FLATTEN
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
    actuallyClipsChildren(
      node
    )
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


function collectFlattenCandidates(
  root
) {
  const result = [];


  function walk(
    node,
    depth
  ) {
    for (
      const child of
      childrenOf(node)
    ) {
      walk(
        child,
        depth + 1
      );

      if (
        isFlattenCandidate(
          child
        )
      ) {
        result.push({
          node: child,
          depth:
            depth + 1
        });
      }
    }
  }


  walk(root, 0);

  result.sort(
    (a, b) =>
      b.depth -
      a.depth
  );

  return result;
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
      source.width,
      source.height
    );
  } catch (_) {
    safeRemove(rect);
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
    rect.effects =
      source.effects;
  } catch (_) {}

  try {
    rect.opacity =
      source.opacity;
  } catch (_) {}

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
}


/* =========================================================
   NORMAL FLATTEN MUTATION
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
      reason:
        "invalid-parent"
    };
  }

  const index =
    parent.children.indexOf(
      container
    );

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
      removed: 1
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
        reason:
          "font-unavailable"
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


  let insertIndex =
    index;

  let shells = 0;


  if (
    hasOwnVisual(container)
  ) {
    const shell =
      createVisualShell(
        container,
        parent,
        insertIndex
      );

    if (shell) {
      insertIndex++;
      shells++;
    }
  }


  let moved = 0;


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
      insertIndex,
      item.child
    );

    item.child.relativeTransform =
      absoluteToRelative(
        item.transform,
        parent
      );

    moved++;
    insertIndex++;
  }


  safeRemove(
    container
  );


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
   PROCESS FLATTEN
========================================================= */

async function processFlatten(
  state,
  stats
) {
  for (
    let pass = 0;
    pass <
      MAX_FLATTEN_PASSES;
    pass++
  ) {
    const targets =
      collectFlattenCandidates(
        state.root
      );

    if (
      targets.length === 0
    ) {
      break;
    }

    let changedAny = false;


    for (
      const item of
      targets
    ) {
      const node =
        item.node;

      if (!isAlive(node)) {
        continue;
      }


      const oldName =
        safeName(node);

      const oldType =
        safeType(node);


      /* ===================================================
         FAST GEOMETRY PATH
      =================================================== */

      if (
        isFastFlattenCandidate(
          node
        )
      ) {
        const success =
          await fastFlattenContainer(
            node,
            stats
          );

        if (success) {
          changedAny = true;

          addReport(
            stats,
            "Container Flatten",
            "SUCCESS",
            null,
            `${oldType} "${oldName}" · Fast Geometry`
          );

          continue;
        }
      }


      /* ===================================================
         VISUAL PATH
      =================================================== */

      const marker =
        `flatten_${Date.now()}_${Math.random()}`;


      setPD(
        node,
        PD_CURRENT_OP,
        marker
      );


      const tx =
        await runVisualTransaction(
          state,

          async root => {
            const current =
              findByPluginData(
                root,
                PD_CURRENT_OP,
                marker
              );

            if (!current) {
              return {
                root,
                changed: false,
                reason:
                  "container-not-found"
              };
            }

            return await flattenContainerOneLevel(
              root,
              current
            );
          }
        );


      if (
        tx.accepted
      ) {
        changedAny = true;

        stats.flattenedContainers++;

        stats.removedContainers +=
          tx.data &&
          tx.data.removed
            ? tx.data.removed
            : 0;

        stats.movedLayers +=
          tx.data &&
          tx.data.moved
            ? tx.data.moved
            : 0;

        stats.visualShells +=
          tx.data &&
          tx.data.shells
            ? tx.data.shells
            : 0;


        addReport(
          stats,
          "Container Flatten",
          "SUCCESS",
          null,
          `${oldType} "${oldName}" · Visual Verified`
        );

      } else if (
        tx.attempted
      ) {
        stats.flattenRejected++;
        stats.preservedAreas++;

        const restored =
          findByPluginData(
            state.root,
            PD_CURRENT_OP,
            marker
          );

        if (restored) {
          setPD(
            restored,
            PD_SKIP_FLATTEN,
            "1"
          );

          setPD(
            restored,
            PD_CURRENT_OP,
            ""
          );
        }

        addReport(
          stats,
          "Container Flatten",
          "REJECTED",
          restored,
          tx.reason
        );
      }
    }


    if (!changedAny) {
      break;
    }
  }
}


/* =========================================================
   ROOT → FRAME
========================================================= */

async function convertRootToFrame(
  root
) {
  if (
    safeType(root) ===
    "FRAME"
  ) {
    return {
      root,
      changed: false,
      reason:
        "already-frame"
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
        root = detached;
      }
    } catch (_) {}
  }


  if (
    safeType(root) ===
    "FRAME"
  ) {
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
    safeType(parent) !==
      "PAGE"
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


  const transform =
    safeTransform(root);


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
        reason:
          "font-unavailable"
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


  frame.name = "frame";
  frame.fills = [];
  frame.clipsContent = false;


  try {
    frame.layoutMode =
      "NONE";
  } catch (_) {}


  frame.resize(
    root.width,
    root.height
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
      root.fills !==
        figma.mixed
    ) {
      frame.fills =
        root.fills;
    }
  } catch (_) {}


  try {
    if (
      "strokes" in root &&
      root.strokes !==
        figma.mixed
    ) {
      frame.strokes =
        root.strokes;
    }
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
    await runVisualTransaction(
      state,

      async root =>
        await convertRootToFrame(
          root
        )
    );


  if (
    tx.accepted
  ) {
    stats.rootConverted++;

  } else if (
    tx.attempted
  ) {
    stats.rootConversionRejected++;
    stats.preservedAreas++;
  }
}


/* =========================================================
   INTER
========================================================= */

const loadedInterStyles =
  new Set();


function mapInterStyle(
  sourceStyle
) {
  const value =
    String(
      sourceStyle || ""
    ).toLowerCase();


  const italic =
    value.includes(
      "italic"
    );


  let style =
    "Regular";


  if (
    value.includes("black")
  ) {
    style = "Black";

  } else if (
    value.includes("bold")
  ) {
    style = "Bold";

  } else if (
    value.includes("medium")
  ) {
    style = "Medium";

  } else if (
    value.includes("light")
  ) {
    style = "Light";
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
    safeType(node) !==
    "TEXT"
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


  const segments =
    node.getStyledTextSegments(
      ["fontName"]
    );


  let converted = 0;


  for (
    const segment of
    segments
  ) {
    const old =
      segment.fontName &&
      segment.fontName !==
        figma.mixed
        ? segment.fontName.style
        : "Regular";


    const style =
      await loadInterStyle(
        mapInterStyle(old)
      );


    if (!style) {
      continue;
    }


    if (
      segment.fontName &&
      segment.fontName !==
        figma.mixed &&
      segment.fontName.family ===
        "Inter" &&
      segment.fontName.style ===
        style
    ) {
      continue;
    }


    node.setRangeFontName(
      segment.start,
      segment.end,
      {
        family: "Inter",
        style
      }
    );

    converted++;
  }


  return converted;
}


async function processInter(
  state,
  stats
) {
  if (!convertFontToInter) {
    return;
  }


  while (true) {
    let target = null;


    function find(node) {
      if (
        target ||
        !isAlive(node)
      ) {
        return;
      }

      if (
        safeType(node) ===
          "TEXT" &&
        getPD(
          node,
          PD_INTER_DONE
        ) !== "1"
      ) {
        target = node;
        return;
      }

      for (
        const child of
        childrenOf(node)
      ) {
        find(child);

        if (target) {
          return;
        }
      }
    }


    find(state.root);


    if (!target) {
      break;
    }


    const marker =
      `inter_${Date.now()}_${Math.random()}`;


    setPD(
      target,
      PD_CURRENT_OP,
      marker
    );


    const tx =
      await runVisualTransaction(
        state,

        async root => {
          const text =
            findByPluginData(
              root,
              PD_CURRENT_OP,
              marker
            );

          if (!text) {
            return {
              root,
              changed: false,
              reason:
                "text-not-found"
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
              count
          };
        }
      );


    if (
      tx.accepted
    ) {
      stats.convertedTexts++;

      stats.convertedFontSegments +=
        tx.data &&
        tx.data.converted
          ? tx.data.converted
          : 0;

    } else {
      const restored =
        findByPluginData(
          state.root,
          PD_CURRENT_OP,
          marker
        );

      if (restored) {
        setPD(
          restored,
          PD_INTER_DONE,
          "1"
        );

        setPD(
          restored,
          PD_CURRENT_OP,
          ""
        );
      }

      if (
        tx.attempted
      ) {
        stats.failedFontConversions++;
      }
    }
  }
}


/* =========================================================
   NAMING
========================================================= */

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
    value.includes(
      "material-symbol"
    )
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

  const name =
    safeName(node)
      .toLowerCase();

  if (
    name.includes(
      "screenshot"
    ) ||
    name.includes(
      "스크린샷"
    )
  ) {
    return true;
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


  if (
    type === "TEXT"
  ) {
    return renameTextToHyphen
      ? "-"
      : current;
  }


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


  if (
    type === "GROUP"
  ) {
    return "group";
  }


  if (
    type === "FRAME"
  ) {
    return "frame";
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
      wanted !==
        safeName(node)
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
      a.y - b.y
    ) <=
      ROW_Y_TOLERANCE
  ) {
    return true;
  }

  const top =
    Math.max(
      a.y,
      b.y
    );

  const bottom =
    Math.min(
      a.bottom,
      b.bottom
    );

  const overlap =
    bottom - top;

  if (
    overlap <= 0
  ) {
    return false;
  }

  return (
    overlap >=
    Math.min(
      a.height,
      b.height
    ) * 0.5
  );
}


function boundsOverlap(
  a,
  b
) {
  if (!a || !b) {
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
            !a.bounds ||
            !b.bounds
          ) {
            return (
              a.originalPanelIndex -
              b.originalPanelIndex
            );
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

    let row = null;

    for (
      const candidate of rows
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
        if (
          !a.bounds ||
          !b.bounds
        ) {
          return (
            a.originalPanelIndex -
            b.originalPanelIndex
          );
        }

        return (
          a.bounds.x -
          b.bounds.x
        );
      }
    );
  }


  return rows;
}


function buildSafeDesiredPanelOrder(
  root
) {
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


  const rows =
    buildVisualRows(
      items
    );


  const visual = [];


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
   * 겹치는 Layer는
   * 기존 Z-order 보존
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


  const output = [];


  while (
    available.length
  ) {
    available.sort(
      (a, b) =>
        a.desiredRank -
        b.desiredRank
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


  if (
    output.length !==
    items.length
  ) {
    return null;
  }


  return output;
}


async function reorderRootLayers(
  root
) {
  if (
    isAutoLayout(root)
  ) {
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
      reason:
        "single-layer"
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
      reason:
        "z-order-cycle"
    };
  }


  const desired =
    panel
      .map(
        item =>
          item.node
      )
      .reverse();


  let changed = false;


  for (
    let i = 0;
    i < children.length;
    i++
  ) {
    if (
      children[i] !==
      desired[i]
    ) {
      changed = true;
      break;
    }
  }


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
    changed: true,
    reason:
      "ordered"
  };
}


async function processOrder(
  state,
  stats
) {
  const tx =
    await runVisualTransaction(
      state,

      async root =>
        await reorderRootLayers(
          root
        )
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
      tx.reason
    );
  }
}


/* =========================================================
   ANALYZE
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

  return {
    total:
      1 +
      countAllLayers(root),

    garbage:
      garbageItems.length,

    garbageItems,

    rootType:
      safeType(root)
  };
}


/* =========================================================
   COMMIT
========================================================= */

function commitWorkingRoot(
  original,
  working
) {
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

  working.x =
    original.x;

  working.y =
    original.y;

  parent.insertChild(
    index,
    working
  );

  safeRemove(original);

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
        error.message
    };
  }


  markSelectedGarbage(
    originalRoot,
    state.root
  );


  /* 1. Garbage */
  await processGarbage(
    state,
    stats
  );


  /* 2. Root Frame */
  await processRootConversion(
    state,
    stats
  );


  /* 3. Instance */
  await processInstances(
    state,
    stats
  );


  /* 4. Mask / Clip */
  await processScreenshots(
    state,
    stats
  );


  /* 5. Flatten */
  await processFlatten(
    state,
    stats
  );


  /* 6. Font */
  await processInter(
    state,
    stats
  );


  /* 7. Naming */
  processNaming(
    state.root,
    stats
  );


  /* 8. Order */
  await processOrder(
    state,
    stats
  );


  clearInternalPluginData(
    state.root
  );


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
    stats
  };
}


/* =========================================================
   ANALYZED ROOT
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
   UI
========================================================= */

figma.ui.onmessage =
async msg => {


  /* CLOSE */

  if (
    msg.type === "close"
  ) {
    figma.closePlugin();
    return;
  }


  /* VIEW GARBAGE */

  if (
    msg.type ===
    "select-layer"
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

      figma.viewport
        .scrollAndZoomIntoView(
          [node]
        );

    } catch (_) {}

    return;
  }


  /* ANALYZE */

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
        type: "error",
        message:
`지원 타입:
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


  /* CLEAN */

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
          "Analyze했던 Screen을 찾을 수 없습니다."
      });

      return;
    }


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

      report: [],
      failureReasons: []
    };


    for (
      const root of roots
    ) {
      try {
        const result =
          await processRoot(
            root
          );


        if (
          result.root &&
          isAlive(result.root)
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
            typeof total[key] ===
              "number"
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
            error.message ||
            String(error)
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
        node =>
          isAlive(node)
      );


    if (
      aliveRoots.length
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
            node =>
              safeId(node)
          )
          .filter(Boolean);
    }


    figma.ui.postMessage({
      type: "complete",
      result:
        total
    });


    console.log(
      "========================================"
    );

    console.log(
      "SCREEN LAYER CLEANER REPORT"
    );

    console.log(
      "========================================"
    );

    console.log(
      "Fast Garbage:",
      total.fastGarbage
    );

    console.log(
      "Garbage Deleted:",
      total.removedGarbage
    );

    console.log(
      "Fast Flatten:",
      total.fastFlatten
    );

    console.log(
      "Flatten Total:",
      total.flattenedContainers
    );

    console.log(
      "Instance Detached:",
      total.detachedInstances
    );

    console.log(
      "Screenshot:",
      total.screenshotBaked
    );

    console.log(
      "Renamed:",
      total.renamedLayers
    );

    console.log(
      "Order:",
      total.orderChanged
    );


    try {
      console.table(
        total.report
      );
    } catch (_) {}


    figma.notify(
      `Cleanup 완료 · Garbage ${total.removedGarbage} · Flatten ${total.flattenedContainers} · Fast ${total.fastGarbage + total.fastFlatten}`
    );

    return;
  }
};
