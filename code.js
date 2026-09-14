figma.showUI(__html__, {
  width: 440,
  height: 760,
  themeColors: true
});


/* =========================================================
   SCREEN LAYER CLEANER
   STABLE ATOMIC TRANSACTION VERSION

   제1법칙
   ---------------------------------------------------------
   디자인 화면의 Render는 변경하지 않는다.

   변경 가능 작업:
   - Garbage 삭제
   - Instance Detach
   - Root → Frame
   - Mask / Clip → screenshot
   - Frame / Group / Auto Layout Flatten
   - Font → Inter
   - Layer Order

   위 작업들은 각각:

   BEFORE
   ↓
   작업
   ↓
   AFTER
   ↓
   Render 동일 → 확정
   Render 다름 → 해당 작업만 Rollback

   중요:
   ---------------------------------------------------------
   - Screen 전체 Final Rollback 제거
   - Original ↔ Clone PNG 비교 제거
   - 현재 작업본의 BEFORE ↔ AFTER만 비교
   - Naming은 Render에 영향을 주지 않으므로 직접 적용
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

const MAX_INSTANCE_PASSES = 10;
const MAX_SCREENSHOT_PASSES = 10;
const MAX_FLATTEN_PASSES = 30;


/* =========================================================
   INTERNAL DATA
========================================================= */

const PD_GARBAGE_ID =
  "slc_garbage_id";

const PD_CURRENT_OP =
  "slc_current_op";

const PD_SKIP_DETACH =
  "slc_skip_detach";

const PD_SKIP_SCREENSHOT =
  "slc_skip_screenshot";

const PD_SKIP_FLATTEN =
  "slc_skip_flatten";

const PD_INTER_DONE =
  "slc_inter_done";


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

    return [
      ...node.children
    ];

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

  } catch (error) {
    console.warn(
      "Remove failed:",
      safeName(node),
      error
    );

    return false;
  }
}


/* =========================================================
   NODE TYPES
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


function clearInternalPluginData(
  root
) {
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


/* =========================================================
   ORIGINAL → CLONE PATH
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
        [
          ...path,
          i
        ]
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
      index >=
        children.length
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
   RENDER EXPORT
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

  } catch (error) {
    console.warn(
      "PNG export failed:",
      safeName(node),
      error
    );

    return null;
  }
}


/* =========================================================
   BYTE COMPARE
   ---------------------------------------------------------
   IMPORTANT

   더 이상 Original ↔ Clone이나
   마지막 전체 Screen 판정에 사용하지 않는다.

   동일한 Working Root의
   "바로 직전 Export ↔ 바로 직후 Export"
   비교에만 사용한다.

   따라서 이전처럼 Clone 생성/Final Export 차이 때문에
   Screen 전체가 Rollback 되는 문제를 제거한다.
========================================================= */

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
   WORKING STATE
========================================================= */

async function createWorkingState(
  originalRoot
) {
  /*
   * ★ 변경
   *
   * Original PNG와 Clone PNG를 비교하지 않는다.
   *
   * Figma clone()은 구조 복제이고,
   * 실제 위험 작업은 이후 Atomic Transaction에서
   * 하나씩 검증한다.
   */

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

  /*
   * Export가 가능한 Clone인지만 확인.
   */
  const initial =
    await exportNodePng(
      clone
    );

  if (!initial) {
    safeRemove(clone);

    throw new Error(
      "작업용 Screen을 Render할 수 없습니다."
    );
  }

  return {
    root:
      clone
  };
}


/* =========================================================
   ATOMIC VISUAL TRANSACTION
========================================================= */

/*
 * ★ 이번 안정화의 핵심
 *
 * OLD:
 *
 * Original baseline
 * vs
 * 모든 변경 이후 Working
 *
 *
 * NEW:
 *
 * Current Working BEFORE
 * vs
 * Current Working AFTER
 *
 *
 * 즉 해당 Operation 하나가
 * 실제 화면을 바꿨는지만 검사한다.
 */
async function runVisualTransaction(
  state,
  mutate
) {
  if (
    !state ||
    !isAlive(state.root)
  ) {
    return {
      accepted:
        false,

      attempted:
        false,

      reason:
        "working-root-missing"
    };
  }


  const currentRoot =
    state.root;


  /*
   * 현재 상태 Snapshot.
   */
  const before =
    await exportNodePng(
      currentRoot
    );


  if (!before) {
    return {
      accepted:
        false,

      attempted:
        false,

      reason:
        "before-render-failed"
    };
  }


  /*
   * Rollback용 Clone.
   */
  let checkpoint =
    null;


  const rootX =
    currentRoot.x;

  const rootY =
    currentRoot.y;


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
    if (
      checkpoint &&
      isAlive(checkpoint)
    ) {
      safeRemove(checkpoint);
    }


    return {
      accepted:
        false,

      attempted:
        false,

      reason:
        "checkpoint-create-failed",

      error
    };
  }


  let mutationResult;


  try {
    mutationResult =
      await mutate(
        currentRoot
      );

  } catch (error) {

    /*
     * Operation Error
     * → 즉시 해당 작업만 Rollback.
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
      accepted:
        false,

      attempted:
        true,

      reason:
        "operation-error",

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


  /*
   * Mutation 함수가 아무것도 안 했다고 했더라도
   * 실제로는 예상치 못한 변경이 있었는지 검사한다.
   */
  const after =
    await exportNodePng(
      state.root
    );


  if (!after) {

    /*
     * Render 자체가 안 되면 Rollback.
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
      accepted:
        false,

      attempted:
        true,

      reason:
        "after-render-failed",

      data:
        mutationResult
    };
  }


  /*
   * BEFORE === AFTER
   *
   * 화면 변화 없음.
   */
  const visuallySame =
    sameBytes(
      before,
      after
    );


  /*
   * changed:false + 화면도 동일
   * → No-op.
   */
  if (
    !changed &&
    visuallySame
  ) {
    safeRemove(
      checkpoint
    );


    return {
      accepted:
        false,

      attempted:
        false,

      reason:
        mutationResult &&
        mutationResult.reason
          ? mutationResult.reason
          : "no-change",

      data:
        mutationResult
    };
  }


  /*
   * changed:true + 화면 동일
   *
   * 정상 Commit.
   */
  if (
    changed &&
    visuallySame
  ) {
    safeRemove(
      checkpoint
    );


    return {
      accepted:
        true,

      attempted:
        true,

      reason:
        "visual-identical",

      data:
        mutationResult
    };
  }


  /*
   * changed:false인데 화면은 달라짐.
   *
   * 이건 Mutation 함수 내부에서
   * 우리가 추적하지 못한 변경이 발생한 것.
   *
   * 반드시 Rollback.
   */
  if (
    !changed &&
    !visuallySame
  ) {
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
      accepted:
        false,

      attempted:
        true,

      reason:
        "unexpected-mutation",

      data:
        mutationResult
    };
  }


  /*
   * changed:true + 화면 다름
   *
   * 제1법칙 위반.
   *
   * 해당 작업만 Rollback.
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
    accepted:
      false,

    attempted:
      true,

    reason:
      "visual-changed",

    data:
      mutationResult
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
   GARBAGE
========================================================= */

function getGarbageReason(node) {
  if (!isAlive(node)) {
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
    safeType(node) ===
    "SLICE"
  ) {
    return "Slice Layer";
  }


  return null;
}


function collectGarbageItems(root) {
  const result =
    [];


  function walk(
    node,
    displayPath
  ) {
    if (!isAlive(node)) {
      return;
    }


    const name =
      safeName(node);


    const currentPath =
      displayPath
        ? `${displayPath} / ${name}`
        : name;


    const reason =
      getGarbageReason(node);


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
   MARK GARBAGE
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
   COUNT MARKED GARBAGE
========================================================= */

function countMarkedGarbage(node) {
  let count =
    0;


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


/* =========================================================
   PROCESS GARBAGE
========================================================= */

async function processGarbage(
  state,
  stats
) {
  while (true) {
    let target =
      null;

    let shallowestDepth =
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
        getGarbageReason(node) &&
        depth < shallowestDepth
      ) {
        target =
          node;

        shallowestDepth =
          depth;
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


    const originalGarbageId =
      getPD(
        target,
        PD_GARBAGE_ID
      );


    const name =
      safeName(target);

    const type =
      safeType(target);

    const garbageReason =
      getGarbageReason(target);


    const count =
      countMarkedGarbage(
        target
      );


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

              changed:
                false,

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
      stats.removedGarbage +=
        count;


      addReport(
        stats,
        "Garbage Delete",
        "SUCCESS",
        null,
        `${type} "${name}" 삭제 완료 (${garbageReason})`
      );


      continue;
    }


    stats.protectedGarbage +=
      count;


    const restored =
      findByPluginData(
        state.root,
        PD_GARBAGE_ID,
        originalGarbageId
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
        ? "삭제하면 현재 화면 Render가 변경되어 해당 Garbage만 유지했습니다."
        : `삭제 실패: ${tx.reason}`
    );
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


async function ensureTextFontsLoaded(node) {
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
      const segment of segments
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

  } catch (_) {}


  try {
    if (
      node.fontName !==
      figma.mixed
    ) {
      return await loadFontOnce(
        node.fontName
      );
    }

  } catch (_) {}


  return false;
}


async function ensureSubtreeFontsLoaded(node) {
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
   INSTANCE DETACH
========================================================= */

function collectInstances(root) {
  const result =
    [];


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
          node:
            child,

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


  walk(
    root,
    0
  );


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
    pass < MAX_INSTANCE_PASSES;
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


    let acceptedAny =
      false;


    for (
      const item of targets
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

                changed:
                  false,

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

        acceptedAny =
          true;


        addReport(
          stats,
          "Instance Detach",
          "SUCCESS",
          null,
          `"${oldName}" Instance 해제 완료`
        );


        continue;
      }


      if (
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
          tx.reason ===
            "visual-changed"
            ? "Instance 해제 시 Render가 변경되어 기존 Instance를 유지했습니다."
            : `Detach 실패: ${tx.reason}`
        );
      }
    }


    if (!acceptedAny) {
      break;
    }
  }
}


/* =========================================================
   MASK
========================================================= */

function containsMask(node) {
  for (
    const child of
    childrenOf(node)
  ) {
    try {
      if (
        "isMask" in child &&
        child.isMask === true
      ) {
        return true;
      }
    } catch (_) {}


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


  const left =
    box.x;

  const top =
    box.y;

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
   SCREENSHOT CANDIDATES
========================================================= */

function collectScreenshotCandidates(
  root
) {
  const result =
    [];


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
          node:
            child,

          depth:
            depth + 1
        });
      }
    }
  }


  walk(
    root,
    0
  );


  result.sort(
    (a, b) =>
      b.depth -
      a.depth
  );


  return result;
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

      changed:
        false,

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

      changed:
        false,

      reason:
        "invalid-render-bounds"
    };
  }


  let index =
    -1;


  try {
    index =
      parent.children.indexOf(
        container
      );

  } catch (_) {}


  if (
    index < 0
  ) {
    return {
      root,

      changed:
        false,

      reason:
        "index-invalid"
    };
  }


  const bytes =
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

    changed:
      true,

    reason:
      "screenshot-created"
  };
}


/* =========================================================
   PROCESS SCREENSHOTS
========================================================= */

async function processScreenshots(
  state,
  stats
) {
  for (
    let pass = 0;
    pass < MAX_SCREENSHOT_PASSES;
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


    let acceptedAny =
      false;


    for (
      const item of targets
    ) {
      const node =
        item.node;


      if (!isAlive(node)) {
        continue;
      }


      const oldName =
        safeName(node);


      const marker =
        `shot_${Date.now()}_${Math.random()}`;


      setPD(
        node,
        PD_CURRENT_OP,
        marker
      );


      const tx =
        await runVisualTransaction(
          state,

          async root => {
            const target =
              findByPluginData(
                root,
                PD_CURRENT_OP,
                marker
              );


            if (!target) {
              return {
                root,

                changed:
                  false,

                reason:
                  "container-not-found"
              };
            }


            return await replaceWithScreenshot(
              root,
              target
            );
          }
        );


      if (
        tx.accepted
      ) {
        stats.screenshotBaked++;
        stats.bakedAreas++;

        acceptedAny =
          true;


        addReport(
          stats,
          "Mask / Clip",
          "SUCCESS",
          null,
          `"${oldName}" → screenshot`
        );


        continue;
      }


      if (
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


        addReport(
          stats,
          "Mask / Clip",
          "REJECTED",
          restored,
          tx.reason ===
            "visual-changed"
            ? "Screenshot 변환 시 Render가 달라져 기존 구조를 유지했습니다."
            : `Screenshot 변환 실패: ${tx.reason}`
        );
      }
    }


    if (!acceptedAny) {
      break;
    }
  }
}


/* =========================================================
   PAINT
========================================================= */

function hasVisiblePaint(paints) {
  if (
    !Array.isArray(paints)
  ) {
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


function hasOwnVisual(node) {
  if (!isAlive(node)) {
    return false;
  }


  try {
    if (
      "fills" in node &&
      node.fills !== figma.mixed &&
      hasVisiblePaint(
        node.fills
      )
    ) {
      return true;
    }
  } catch (_) {}


  try {
    if (
      "strokes" in node &&
      node.strokes !== figma.mixed &&
      hasVisiblePaint(
        node.strokes
      )
    ) {
      return true;
    }
  } catch (_) {}


  return false;
}


function hasImageFill(node) {
  try {
    if (
      !("fills" in node) ||
      node.fills === figma.mixed ||
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
    safeRemove(rect);

    return null;
  }
}


/* =========================================================
   FLATTEN CANDIDATES
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


  /*
   * Mask / Real Clip은
   * screenshot 단계에서 먼저 처리한다.
   */
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


function collectFlattenCandidates(
  root
) {
  const result =
    [];


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
          node:
            child,

          depth:
            depth + 1
        });
      }
    }
  }


  walk(
    root,
    0
  );


  result.sort(
    (a, b) =>
      b.depth -
      a.depth
  );


  return result;
}


/* =========================================================
   FLATTEN ONE LEVEL
========================================================= */

async function flattenContainerOneLevel(
  root,
  container
) {
  if (!isAlive(container)) {
    return {
      root,

      changed:
        false,

      reason:
        "container-missing"
    };
  }


  const parent =
    safeParent(container);


  if (
    !parent ||
    !("children" in parent)
  ) {
    return {
      root,

      changed:
        false,

      reason:
        "invalid-parent"
    };
  }


  let index =
    -1;


  try {
    index =
      parent.children.indexOf(
        container
      );

  } catch (_) {}


  if (
    index < 0
  ) {
    return {
      root,

      changed:
        false,

      reason:
        "index-invalid"
    };
  }


  const children =
    childrenOf(container);


  /*
   * Empty Frame.
   */
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

      moved:
        0,

      removed:
        1,

      shells:
        0
    };
  }


  /*
   * Text 이동 전 Font load.
   */
  for (
    const child of children
  ) {
    if (
      !await ensureSubtreeFontsLoaded(
        child
      )
    ) {
      return {
        root,

        changed:
          false,

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
    return {
      root,

      changed:
        false,

      reason:
        "transform-unavailable"
    };
  }


  let insertionIndex =
    index;

  let shells =
    0;


  /*
   * Container 자체 Background/Stroke가 있으면
   * shape로 보존.
   */
  if (
    hasOwnVisual(
      container
    )
  ) {
    const shell =
      createVisualShell(
        container,
        parent,
        insertionIndex
      );


    if (shell) {
      insertionIndex++;
      shells++;
    }
  }


  let moved =
    0;


  for (
    const item of snapshots
  ) {
    const child =
      item.child;


    /*
     * Parent가 Auto Layout이라면
     * child를 Absolute로 올려 위치 보존 시도.
     */
    try {
      if (
        isAutoLayout(parent) &&
        "layoutPositioning" in
          child
      ) {
        child.layoutPositioning =
          "ABSOLUTE";
      }
    } catch (_) {}


    parent.insertChild(
      insertionIndex,
      child
    );


    child.relativeTransform =
      absoluteToRelative(
        item.transform,
        parent
      );


    insertionIndex++;
    moved++;
  }


  if (
    childrenOf(container)
      .length !== 0
  ) {
    throw new Error(
      "Container children remain after flatten."
    );
  }


  safeRemove(
    container
  );


  return {
    root,

    changed:
      true,

    reason:
      "flattened",

    moved,

    removed:
      1,

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
    pass < MAX_FLATTEN_PASSES;
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


    let acceptedAny =
      false;


    for (
      const item of targets
    ) {
      const node =
        item.node;


      if (!isAlive(node)) {
        continue;
      }


      const nodeName =
        safeName(node);

      const nodeType =
        safeType(node);


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

                changed:
                  false,

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
        acceptedAny =
          true;


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
          `${nodeType} "${nodeName}" 해제 완료`
        );


        continue;
      }


      /*
       * 작업을 실제 시도했다가 Reject.
       */
      if (
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


        let reason =
          tx.reason;


        if (
          reason ===
          "visual-changed"
        ) {
          reason =
            "Container를 풀면 실제 Render가 변경됨";

        } else if (
          reason ===
          "unexpected-mutation"
        ) {
          reason =
            "Flatten 함수가 changed=false를 반환했지만 화면 변화가 감지됨";

        } else if (
          tx.data &&
          tx.data.reason
        ) {
          reason =
            tx.data.reason;
        }


        addReport(
          stats,
          "Container Flatten",
          "REJECTED",
          restored,
          reason
        );


        continue;
      }


      /*
       * 기술적으로 시도도 못한 경우.
       */
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
        "SKIPPED",
        restored,
        tx.data &&
        tx.data.reason
          ? tx.data.reason
          : tx.reason
      );
    }


    if (!acceptedAny) {
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

      changed:
        false,

      reason:
        "already-frame"
    };
  }


  /*
   * Root Instance.
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
        root =
          detached;
      }

    } catch (_) {
      return {
        root,

        changed:
          false,

        reason:
          "root-instance-detach-failed"
      };
    }
  }


  if (
    safeType(root) ===
    "FRAME"
  ) {
    return {
      root,

      changed:
        true,

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

      changed:
        false,

      reason:
        "root-not-page-child"
    };
  }


  let index =
    -1;


  try {
    index =
      parent.children.indexOf(
        root
      );

  } catch (_) {}


  if (
    index < 0
  ) {
    return {
      root,

      changed:
        false,

      reason:
        "root-index-invalid"
    };
  }


  const transform =
    safeTransform(root);


  if (!transform) {
    return {
      root,

      changed:
        false,

      reason:
        "root-transform-unavailable"
    };
  }


  const children =
    childrenOf(root);


  for (
    const child of children
  ) {
    if (
      !await ensureSubtreeFontsLoaded(
        child
      )
    ) {
      return {
        root,

        changed:
          false,

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
    return {
      root,

      changed:
        false,

      reason:
        "child-transform-unavailable"
    };
  }


  let width =
    1;

  let height =
    1;


  try {
    width =
      root.width;

    height =
      root.height;

  } catch (_) {}


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
    Math.max(
      width,
      0.01
    ),

    Math.max(
      height,
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
   * Root Visual 복제.
   */
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


  try {
    frame.effects =
      root.effects;
  } catch (_) {}


  try {
    frame.opacity =
      root.opacity;
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


  safeRemove(
    root
  );


  return {
    root:
      frame,

    changed:
      true,

    reason:
      "converted-to-frame"
  };
}


/* =========================================================
   PROCESS ROOT CONVERSION
========================================================= */

async function processRootConversion(
  state,
  stats
) {
  if (
    safeType(state.root) ===
    "FRAME"
  ) {
    addReport(
      stats,
      "Root → Frame",
      "SKIPPED",
      state.root,
      "Already Frame"
    );

    return;
  }


  const beforeType =
    safeType(
      state.root
    );


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


    addReport(
      stats,
      "Root → Frame",
      "SUCCESS",
      state.root,
      `${beforeType} → FRAME`
    );


    return;
  }


  if (
    tx.attempted
  ) {
    stats.rootConversionRejected++;
    stats.preservedAreas++;


    addReport(
      stats,
      "Root → Frame",
      "REJECTED",
      state.root,
      tx.reason ===
        "visual-changed"
        ? "Frame 변환 시 실제 Render가 변경됨"
        : tx.reason
    );


    return;
  }


  addReport(
    stats,
    "Root → Frame",
    "SKIPPED",
    state.root,
    tx.data &&
    tx.data.reason
      ? tx.data.reason
      : tx.reason
  );
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
    )
      .toLowerCase()
      .replace(
        /[_-]/g,
        " "
      );


  const italic =
    value.includes(
      "italic"
    ) ||
    value.includes(
      "oblique"
    );


  let style =
    "Regular";


  if (
    value.includes("black") ||
    value.includes("heavy")
  ) {
    style =
      "Black";

  } else if (
    value.includes(
      "extra bold"
    ) ||
    value.includes(
      "extrabold"
    )
  ) {
    style =
      "Extra Bold";

  } else if (
    value.includes(
      "semi bold"
    ) ||
    value.includes(
      "semibold"
    )
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
    value.includes(
      "extra light"
    ) ||
    value.includes(
      "extralight"
    )
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
      family:
        "Inter",

      style
    });


    loadedInterStyles.add(
      style
    );


    return style;

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


  try {
    const segments =
      node.getStyledTextSegments(
        ["fontName"]
      );


    let converted =
      0;


    for (
      const segment of segments
    ) {
      const oldStyle =
        segment.fontName &&
        segment.fontName !==
          figma.mixed
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
        segment.fontName !==
          figma.mixed &&
        segment.fontName.family ===
          "Inter" &&
        segment.fontName.style ===
          newStyle
      ) {
        continue;
      }


      node.setRangeFontName(
        segment.start,
        segment.end,
        {
          family:
            "Inter",

          style:
            newStyle
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
   PROCESS INTER
========================================================= */

async function processInter(
  state,
  stats
) {
  if (!convertFontToInter) {
    return;
  }


  while (true) {
    let target =
      null;


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
        target =
          node;

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


    find(
      state.root
    );


    if (!target) {
      break;
    }


    const name =
      safeName(target);


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

              changed:
                false,

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
              count,

            reason:
              count > 0
                ? "font-converted"
                : "already-inter-or-unavailable"
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


      addReport(
        stats,
        "Font → Inter",
        "SUCCESS",
        null,
        `"${name}"`
      );


      continue;
    }


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


      addReport(
        stats,
        "Font → Inter",
        "REJECTED",
        restored,
        tx.reason ===
          "visual-changed"
          ? "Inter 적용 시 실제 Render가 달라 기존 Font 유지"
          : tx.reason
      );
    }
  }
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
    value.includes(
      "screenshot"
    ) ||
    value.includes(
      "screen shot"
    ) ||
    value.includes(
      "스크린샷"
    )
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
    value.startsWith(
      "icon/"
    ) ||
    value.includes(
      "/icon"
    ) ||
    value.startsWith(
      "ic_"
    ) ||
    value.includes(
      "/ic_"
    ) ||
    value.includes(
      "material-symbol"
    ) ||
    value.includes(
      "material_symbol"
    )
  );
}


function looksLikeIcon(node) {
  const type =
    safeType(node);

  const name =
    safeName(node);


  if (
    looksLikeIconName(name)
  ) {
    return true;
  }


  if (
    type === "VECTOR" ||
    type ===
      "BOOLEAN_OPERATION" ||
    type === "POLYGON" ||
    type === "STAR"
  ) {
    return true;
  }


  return false;
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


function desiredLayerName(
  node,
  root
) {
  const type =
    safeType(node);


  const current =
    safeName(node);


  /*
   * LID 최우선 보호.
   */
  if (
    isLidName(current)
  ) {
    return current;
  }


  /*
   * TEXT
   */
  if (
    type === "TEXT"
  ) {
    return renameTextToHyphen
      ? "-"
      : current;
  }


  /*
   * IMAGE
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
   * LINE
   */
  if (
    looksLikeLine(node)
  ) {
    return "line";
  }


  /*
   * ICON
   */
  if (
    looksLikeIcon(node)
  ) {
    return "icon";
  }


  /*
   * SHAPE
   */
  if (
    type === "RECTANGLE" ||
    type === "ELLIPSE" ||
    type === "POLYGON" ||
    type === "STAR" ||
    type ===
      "BOOLEAN_OPERATION" ||
    type === "VECTOR"
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
      wanted !==
        safeName(node)
    ) {
      try {
        node.name =
          wanted;


        stats.renamedLayers++;

      } catch (_) {
        stats.renameSkipped++;


        addReport(
          stats,
          "Layer Rename",
          "REJECTED",
          node,
          "Figma가 Name 변경을 허용하지 않음"
        );
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
  const bounds =
    safeBounds(node);


  if (!bounds) {
    return null;
  }


  return {
    x:
      bounds.x,

    y:
      bounds.y,

    width:
      bounds.width,

    height:
      bounds.height,

    right:
      bounds.x +
      bounds.width,

    bottom:
      bounds.y +
      bounds.height
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


  /*
   * Top Y가 유사.
   */
  if (
    Math.abs(
      a.y -
      b.y
    ) <= ROW_Y_TOLERANCE
  ) {
    return true;
  }


  /*
   * Vertical overlap.
   */
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


  if (
    minHeight <= 0
  ) {
    return false;
  }


  return (
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


/* =========================================================
   VISUAL ROWS
========================================================= */

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
    const item of sorted
  ) {
    if (!item.bounds) {
      rows.push({
        y:
          Infinity,

        items:
          [item]
      });

      continue;
    }


    let row =
      null;


    for (
      const candidate of rows
    ) {
      if (
        candidate.items.some(
          existing =>
            existing.bounds &&
            isSameVisualRow(
              existing.bounds,
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


    row.items.push(
      item
    );


    row.y =
      Math.min(
        row.y,
        item.bounds.y
      );
  }


  /*
   * 위 → 아래.
   */
  rows.sort(
    (a, b) =>
      a.y -
      b.y
  );


  /*
   * 같은 줄 좌 → 우.
   */
  for (
    const row of rows
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


/* =========================================================
   SAFE PANEL ORDER
========================================================= */

function buildSafeDesiredPanelOrder(
  root
) {
  const children =
    childrenOf(root);


  /*
   * Figma Layer panel은
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
          getOrderBounds(
            node
          ),

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


  const visualOrder =
    [];


  for (
    const row of rows
  ) {
    visualOrder.push(
      ...row.items
    );
  }


  visualOrder.forEach(
    (item, index) => {
      item.desiredRank =
        index;
    }
  );


  /*
   * 겹치는 Layer는
   * 기존 Z-order를 constraint로 유지.
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
      const front =
        items[i];

      const back =
        items[j];


      if (
        boundsOverlap(
          front.bounds,
          back.bounds
        )
      ) {
        front.outgoing.add(
          back
        );


        back.indegree++;
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
        const rank =
          a.desiredRank -
          b.desiredRank;


        if (
          rank !== 0
        ) {
          return rank;
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


/* =========================================================
   REORDER ROOT
========================================================= */

async function reorderRootLayers(
  root
) {
  if (!isAlive(root)) {
    return {
      root,

      changed:
        false,

      reason:
        "root-missing"
    };
  }


  /*
   * Auto Layout Root 순서를 실제로 바꾸면
   * 화면 Layout이 변할 수 있으므로 Skip.
   */
  if (
    isAutoLayout(root)
  ) {
    return {
      root,

      changed:
        false,

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

      changed:
        false,

      reason:
        "single-layer"
    };
  }


  const panelOrder =
    buildSafeDesiredPanelOrder(
      root
    );


  if (!panelOrder) {
    return {
      root,

      changed:
        false,

      reason:
        "z-order-cycle"
    };
  }


  const desiredChildren =
    panelOrder
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

      changed:
        false,

      reason:
        "already-ordered"
    };
  }


  for (
    let i = 0;
    i < desiredChildren.length;
    i++
  ) {
    const node =
      desiredChildren[i];


    if (!isAlive(node)) {
      continue;
    }


    root.insertChild(
      i,
      node
    );
  }


  return {
    root,

    changed:
      true,

    reason:
      "ordered"
  };
}


/* =========================================================
   PROCESS ORDER
========================================================= */

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
      "화면 위→아래 / 같은 줄 좌→우 순으로 정렬"
    );


    return;
  }


  if (
    tx.attempted
  ) {
    stats.orderRejected++;


    addReport(
      stats,
      "Layer Order",
      "REJECTED",
      state.root,
      tx.reason ===
        "visual-changed"
        ? "Layer 순서를 바꾸면 Z-order Render가 달라져 기존 순서 유지"
        : tx.reason
    );


    return;
  }


  const reason =
    tx.data &&
    tx.data.reason
      ? tx.data.reason
      : tx.reason;


  addReport(
    stats,
    "Layer Order",
    "SKIPPED",
    state.root,
    reason
  );
}


/* =========================================================
   COUNT
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


function countContainers(root) {
  let count =
    0;


  function walk(node) {
    for (
      const child of
      childrenOf(node)
    ) {
      if (
        isContainer(child)
      ) {
        count++;
      }


      walk(child);
    }
  }


  walk(root);


  return count;
}


/* =========================================================
   ANALYZE
========================================================= */

function analyzeScreen(root) {
  const garbageItems =
    collectGarbageItems(
      root
    );


  const result = {
    total:
      1 +
      countAllLayers(
        root
      ),

    garbage:
      garbageItems.length,

    garbageItems,

    containers:
      countContainers(
        root
      ),

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


    try {
      if (
        "isMask" in node &&
        node.isMask === true
      ) {
        result.masks++;
      }
    } catch (_) {}


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
              !segment.fontName ||
              segment.fontName ===
                figma.mixed ||
              segment.fontName.family !==
                "Inter"
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


  return result;
}


/* =========================================================
   COMMIT
========================================================= */

/*
 * ★ 중요
 *
 * Final PNG equality 때문에
 * Screen 전체를 Rollback하지 않는다.
 *
 * 여기까지 도달했다는 것은
 * 각 위험 작업이 개별 Visual Verification을 통과했거나
 * 실패한 작업만 이미 Rollback되었다는 뜻.
 */
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


  let index =
    -1;


  try {
    index =
      parent.children.indexOf(
        original
      );

  } catch (_) {}


  if (
    index < 0
  ) {
    return null;
  }


  const x =
    original.x;

  const y =
    original.y;


  working.x =
    x;

  working.y =
    y;


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
      success:
        false,

      root:
        originalRoot,

      stats,

      fatalReason:
        "Original Root가 존재하지 않습니다."
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
      success:
        false,

      root:
        originalRoot,

      stats,

      fatalReason:
        "선택 Screen은 Page 직속 Layer여야 합니다."
    };
  }


  /* =====================================================
     1. CREATE WORKING COPY
  ===================================================== */

  let state;


  try {
    state =
      await createWorkingState(
        originalRoot
      );

  } catch (error) {
    return {
      success:
        false,

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


  /* =====================================================
     2. MARK GARBAGE
  ===================================================== */

  markSelectedGarbage(
    originalRoot,
    state.root
  );


  /* =====================================================
     3. DELETE GARBAGE
  ===================================================== */

  await processGarbage(
    state,
    stats
  );


  /* =====================================================
     4. ROOT → FRAME
  ===================================================== */

  await processRootConversion(
    state,
    stats
  );


  /* =====================================================
     5. INSTANCE DETACH
  ===================================================== */

  await processInstances(
    state,
    stats
  );


  /* =====================================================
     6. MASK / CLIP
  ===================================================== */

  await processScreenshots(
    state,
    stats
  );


  /* =====================================================
     7. FLATTEN
  ===================================================== */

  await processFlatten(
    state,
    stats
  );


  /* =====================================================
     8. FONT → INTER
  ===================================================== */

  await processInter(
    state,
    stats
  );


  /* =====================================================
     9. NAMING
     -----------------------------------------------------
     Visual에 영향 없음.
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
    `${stats.renamedLayers}개 Layer 이름 정리 완료`
  );


  /* =====================================================
     10. ORDER
  ===================================================== */

  await processOrder(
    state,
    stats
  );


  /* =====================================================
     11. CLEAR INTERNAL DATA
  ===================================================== */

  clearInternalPluginData(
    state.root
  );


  /* =====================================================
     12. COMMIT
     -----------------------------------------------------
     ★ Final 전체 PNG rollback 없음.
  ===================================================== */

  const committed =
    commitWorkingRoot(
      originalRoot,
      state.root
    );


  if (!committed) {
    /*
     * Commit 자체가 실패한 경우에만
     * 원본 유지.
     */
    safeRemove(
      state.root
    );


    return {
      success:
        false,

      root:
        originalRoot,

      stats,

      fatalReason:
        "작업 결과를 원래 Screen 위치에 적용하지 못했습니다."
    };
  }


  stats.finalLayers =
    childrenOf(
      committed
    ).length;


  return {
    success:
      true,

    root:
      committed,

    stats,

    fatalReason:
      null
  };
}


/* =========================================================
   ANALYZED ROOT
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
   UI
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
        node.type ===
          "DOCUMENT" ||
        node.type ===
          "PAGE"
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


    /*
     * analyzedRootIds는 그대로 유지.
     */
    return;
  }


  /* =====================================================
     ANALYZE
  ===================================================== */

  if (
    msg.type ===
    "analyze"
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
        type:
          "error",

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
        type:
          "error",

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


    /*
     * Analyze 대상 고정.
     */
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
    msg.type ===
    "clean"
  ) {
    /*
     * Analyze하지 않고 Clean한 경우에만
     * 현재 Selection 사용.
     */
    if (
      analyzedRootIds.length ===
      0
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
        type:
          "error",

        message:
          "Analyze했던 Screen을 찾을 수 없습니다. Screen을 다시 선택하고 Analyze Screen을 실행해주세요."
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
            key ===
            "report"
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
            error &&
            error.message
              ? error.message
              : String(error)
        });


        if (
          isAlive(root)
        ) {
          resultRoots.push(
            root
          );
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
      type:
        "complete",

      result:
        total
    });


    /* =====================================================
       REPORT
    ===================================================== */

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
      "Garbage Deleted:",
      total.removedGarbage
    );


    console.log(
      "Garbage Preserved:",
      total.protectedGarbage
    );


    console.log(
      "Instances Detached:",
      total.detachedInstances
    );


    console.log(
      "Instances Preserved:",
      total.rejectedInstances
    );


    console.log(
      "Containers Flattened:",
      total.flattenedContainers
    );


    console.log(
      "Containers Preserved:",
      total.flattenRejected
    );


    console.log(
      "Screenshot Bake:",
      total.screenshotBaked
    );


    console.log(
      "Layer Rename:",
      total.renamedLayers
    );


    console.log(
      "Font → Inter:",
      total.convertedTexts
    );


    console.log(
      "Order Changed:",
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
      total.failureReasons.length >
      0
    ) {
      console.error(
        "Fatal failures:",
        total.failureReasons
      );
    }


    /* =====================================================
       NOTIFICATION
    ===================================================== */

    if (
      total.rolledBack === 0
    ) {
      figma.notify(
        `Cleanup 완료 · Garbage ${total.removedGarbage} · Flatten ${total.flattenedContainers} · Rename ${total.renamedLayers}`
      );

    } else {
      figma.notify(
        `Cleanup 완료 · ${total.committed} Screen 적용 / ${total.rolledBack} Screen은 작업 자체 오류로 원본 유지`
      );
    }


    return;
  }
};
