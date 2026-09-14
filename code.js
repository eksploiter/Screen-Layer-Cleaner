figma.showUI(__html__, {
  width: 440,
  height: 760,
  themeColors: true
});


/* =========================================================
   SCREEN LAYER CLEANER
   STRICT VISUAL PRESERVATION / OPERATION TRANSACTION VERSION

   =========================================================
   제1법칙
   =========================================================

   디자인 화면의 실제 렌더 결과를 변경하지 않는다.

   모든 위험 작업은:

   시도
   ↓
   Screen PNG 비교
   ↓
   동일 → Commit
   다름 → 해당 작업만 Rollback

   Screen 전체 Rollback은 최종 검증 실패 같은
   비정상 상황에서만 수행한다.


   =========================================================
   기능
   =========================================================

   - Analyze Root 고정
   - Garbage Review
   - 체크 Garbage 실제 삭제 시도
   - Hidden Frame / Instance 포함
   - Instance Detach
   - Mask / Real Clip → screenshot 변환 시도
   - Frame / Group / Auto Layout Flatten 시도
   - Root Group / Component → Frame 변환 시도
   - LID 이름 유지
   - 일반 Text → "-" 옵션
   - Font → Inter 옵션
   - icon / line / shape / image / screenshot
   - frame / group / instance / component / iphone
   - 위→아래 / 같은 줄 좌→우 Layer Order
   - 실패 이유 Report
========================================================= */


/* =========================================================
   GLOBAL
========================================================= */

let renameTextToHyphen = false;
let convertFontToInter = false;

let approvedGarbageIds = new Set();

/*
 * Analyze한 Screen을 고정한다.
 *
 * Garbage "보기"로 Selection이 바뀌더라도
 * Clean 대상은 바뀌지 않는다.
 */
let analyzedRootIds = [];


const WORK_OFFSET_X = 30000;
const CHECKPOINT_OFFSET_X = 60000;

const ROW_TOLERANCE = 8;

const MAX_INSTANCE_PASSES = 10;
const MAX_SCREENSHOT_PASSES = 10;
const MAX_FLATTEN_PASSES = 30;


/* =========================================================
   PLUGIN DATA KEYS
========================================================= */

const PD_GARBAGE_ID =
  "slc_garbage_id";

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

    screenshotBaked: 0,
    screenshotRejected: 0,

    flattenedContainers: 0,
    flattenRejected: 0,

    rootConverted: 0,
    rootConversionRejected: 0,

    convertedTexts: 0,
    convertedFontSegments: 0,
    failedFontConversions: 0,

    renamedLayers: 0,
    renameSkipped: 0,

    orderChanged: 0,
    orderRejected: 0,

    finalLayers: 0,

    /*
     * 기존 UI 호환
     */
    preservedAreas: 0,
    visualShells: 0,
    bakedAreas: 0,

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
   SAFE NODE HELPERS
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
    if (
      !("children" in node)
    ) {
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
   TYPES
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
  const a =
    m[0][0];

  const c =
    m[0][1];

  const e =
    m[0][2];

  const b =
    m[1][0];

  const d =
    m[1][1];

  const f =
    m[1][2];


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
    return node.getPluginData(
      key
    ) || "";

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
  function walk(node) {
    if (!isAlive(node)) {
      return;
    }


    setPD(
      node,
      PD_GARBAGE_ID,
      ""
    );

    setPD(
      node,
      PD_SKIP_DETACH,
      ""
    );

    setPD(
      node,
      PD_SKIP_SCREENSHOT,
      ""
    );

    setPD(
      node,
      PD_SKIP_FLATTEN,
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
   PNG VISUAL VERIFICATION
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
  const baseline =
    await exportNodePng(
      originalRoot
    );


  if (!baseline) {
    throw new Error(
      "원본 Screen PNG를 생성하지 못했습니다."
    );
  }


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


  const clonePng =
    await exportNodePng(
      clone
    );


  if (
    !clonePng ||
    !sameBytes(
      baseline,
      clonePng
    )
  ) {
    safeRemove(clone);


    throw new Error(
      "작업용 복제본이 원본과 동일하게 렌더되지 않았습니다."
    );
  }


  return {
    root:
      clone,

    baseline
  };
}


/* =========================================================
   TRANSACTION
========================================================= */

/*
 * Screen 전체의 현재 Render를 baseline으로 유지한다.
 *
 * 작업 하나를 수행하고:
 *
 * 동일 → 변경 확정
 * 다름 → 해당 작업만 Rollback
 */
async function runVisualTransaction(
  state,
  mutate
) {
  const workRoot =
    state.root;


  if (!isAlive(workRoot)) {
    return {
      accepted:
        false,

      attempted:
        false,

      reason:
        "working-root-missing"
    };
  }


  let checkpoint =
    null;


  const originalX =
    workRoot.x;

  const originalY =
    workRoot.y;


  try {
    checkpoint =
      workRoot.clone();


    figma.currentPage.appendChild(
      checkpoint
    );


    checkpoint.x =
      originalX +
      CHECKPOINT_OFFSET_X;


    checkpoint.y =
      originalY;

  } catch (error) {
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
        workRoot
      );

  } catch (error) {
    /*
     * Mutation 실패.
     * 현재 Working copy 폐기하고 Checkpoint 복원.
     */
    if (
      isAlive(state.root)
    ) {
      safeRemove(
        state.root
      );
    }


    checkpoint.x =
      originalX;

    checkpoint.y =
      originalY;


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


  const changed =
    !!(
      mutationResult &&
      mutationResult.changed
    );


  const newRoot =
    (
      mutationResult &&
      mutationResult.root &&
      isAlive(
        mutationResult.root
      )
    )
      ? mutationResult.root
      : state.root;


  state.root =
    newRoot;


  if (!changed) {
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


  const after =
    await exportNodePng(
      state.root
    );


  /*
   * 제1법칙 통과
   */
  if (
    after &&
    sameBytes(
      state.baseline,
      after
    )
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
   * 제1법칙 위반
   * → 이 작업만 Rollback.
   */
  if (
    isAlive(state.root)
  ) {
    safeRemove(
      state.root
    );
  }


  checkpoint.x =
    originalX;

  checkpoint.y =
    originalY;


  state.root =
    checkpoint;


  return {
    accepted:
      false,

    attempted:
      true,

    reason:
      after
        ? "visual-changed"
        : "render-check-failed",

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
    return (
      "Slice Layer"
    );
  }


  return null;
}


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


    const displayPath =
      path
        ? `${path} / ${name}`
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
          displayPath
      });
    }


    for (
      const child of
      childrenOf(node)
    ) {
      walk(
        child,
        displayPath
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
  const originalMap =
    createPathMap(
      originalRoot
    );


  for (
    const originalId of
    approvedGarbageIds
  ) {
    const path =
      originalMap.get(
        originalId
      );


    if (!path) {
      continue;
    }


    const workNode =
      resolvePath(
        workRoot,
        path
      );


    if (!workNode) {
      continue;
    }


    setPD(
      workNode,
      PD_GARBAGE_ID,
      originalId
    );
  }
}


/* =========================================================
   GARBAGE PROCESS
========================================================= */

async function processGarbage(
  state,
  stats
) {
  while (true) {

    /*
     * 가장 얕은 선택 Garbage 하나 찾기.
     * 부모를 먼저 삭제하면 자식은 같이 사라진다.
     */
    let target =
      null;

    let targetDepth =
      Infinity;


    function walk(
      node,
      depth
    ) {
      if (!isAlive(node)) {
        return;
      }


      const marker =
        getPD(
          node,
          PD_GARBAGE_ID
        );


      if (
        marker &&
        getGarbageReason(node) &&
        depth <
          targetDepth
      ) {
        target =
          node;

        targetDepth =
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


    const garbageId =
      getPD(
        target,
        PD_GARBAGE_ID
      );


    const beforeName =
      safeName(target);

    const beforeType =
      safeType(target);

    const beforeReason =
      getGarbageReason(
        target
      );


    /*
     * Operation marker 사용.
     */
    const opMarker =
      `garbage_${Date.now()}_${Math.random()}`;


    setPD(
      target,
      "slc_current_op",
      opMarker
    );


    const tx =
      await runVisualTransaction(
        state,

        async root => {
          const node =
            findByPluginData(
              root,
              "slc_current_op",
              opMarker
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


          const removed =
            safeRemove(node);


          return {
            root,

            changed:
              removed,

            reason:
              removed
                ? "deleted"
                : "remove-failed"
          };
        }
      );


    /*
     * Rollback된 Root에서 marker 재확보가 필요.
     */
    if (
      tx.accepted
    ) {
      stats.removedGarbage++;


      addReport(
        stats,
        "Garbage Delete",
        "SUCCESS",
        null,
        `${beforeType} "${beforeName}" 삭제 완료 (${beforeReason})`
      );

    } else {
      stats.protectedGarbage++;


      /*
       * 다시 시도하지 않도록
       * 복원된 Node의 Garbage marker 제거.
       */
      const restored =
        findByPluginData(
          state.root,
          PD_GARBAGE_ID,
          garbageId
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
          ? "삭제 후 화면 Render가 변경되어 제1법칙에 따라 삭제를 취소했습니다."
          : `삭제하지 못했습니다: ${tx.reason}`
      );
    }
  }
}


/* =========================================================
   FONT
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


    loadedFonts.add(
      key
    );


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
    pass <
      MAX_INSTANCE_PASSES;
    pass++
  ) {
    const candidates =
      collectInstances(
        state.root
      );


    if (
      candidates.length === 0
    ) {
      break;
    }


    let acceptedAny =
      false;


    for (
      const item of
      candidates
    ) {
      const target =
        item.node;


      if (!isAlive(target)) {
        continue;
      }


      const marker =
        `instance_${Date.now()}_${Math.random()}`;


      setPD(
        target,
        "slc_current_op",
        marker
      );


      const targetName =
        safeName(target);


      const tx =
        await runVisualTransaction(
          state,

          async root => {
            const instance =
              findByPluginData(
                root,
                "slc_current_op",
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
          `"${targetName}" Instance 해제 완료`
        );

      } else if (
        tx.attempted
      ) {
        stats.rejectedInstances++;


        /*
         * 복원된 Root에서
         * 같은 Operation marker 찾기.
         */
        const restored =
          findByPluginData(
            state.root,
            "slc_current_op",
            marker
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
          tx.reason ===
            "visual-changed"
            ? "Instance 해제 후 Render가 변경되어 원래 Instance를 유지했습니다."
            : `Instance를 해제하지 못했습니다: ${tx.reason}`
        );
      }
    }


    if (!acceptedAny) {
      break;
    }
  }
}


/* =========================================================
   MASK / CLIP
========================================================= */

function containsMask(node) {
  for (
    const child of
    childrenOf(node)
  ) {
    try {
      if (
        "isMask" in child &&
        child.isMask ===
          true
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


function actuallyClipsChildren(node) {
  if (!isAlive(node)) {
    return false;
  }


  try {
    if (
      !("clipsContent" in node) ||
      node.clipsContent !==
        true
    ) {
      return false;
    }
  } catch (_) {
    return false;
  }


  const bounds =
    safeBounds(node);


  if (!bounds) {
    return true;
  }


  const left =
    bounds.x;

  const top =
    bounds.y;

  const right =
    bounds.x +
    bounds.width;

  const bottom =
    bounds.y +
    bounds.height;


  for (
    const child of
    childrenOf(node)
  ) {
    try {
      if (
        "visible" in child &&
        child.visible ===
          false
      ) {
        continue;
      }
    } catch (_) {}


    const childBounds =
      safeRenderBounds(child);


    if (!childBounds) {
      continue;
    }


    if (
      childBounds.x <
        left - 0.5 ||

      childBounds.y <
        top - 0.5 ||

      childBounds.x +
        childBounds.width >
        right + 0.5 ||

      childBounds.y +
        childBounds.height >
        bottom + 0.5
    ) {
      return true;
    }
  }


  return false;
}


/* =========================================================
   SCREENSHOT CANDIDATE
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
        safeType(child) !==
          "INSTANCE" &&

        isContainer(child) &&

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
        "parent-invalid"
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
        "render-bounds-invalid"
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


  /*
   * Parent Auto Layout 내부라면
   * Absolute로 배치해보되
   * 최종 Render Verification에서 검증.
   */
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
   PROCESS MASK / CLIP
========================================================= */

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
    const candidates =
      collectScreenshotCandidates(
        state.root
      );


    if (
      candidates.length ===
      0
    ) {
      break;
    }


    let acceptedAny =
      false;


    for (
      const item of
      candidates
    ) {
      const target =
        item.node;


      if (!isAlive(target)) {
        continue;
      }


      const marker =
        `screenshot_${Date.now()}_${Math.random()}`;


      setPD(
        target,
        "slc_current_op",
        marker
      );


      const targetName =
        safeName(target);


      const tx =
        await runVisualTransaction(
          state,

          async root => {
            const container =
              findByPluginData(
                root,
                "slc_current_op",
                marker
              );


            if (!container) {
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
              container
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
          `"${targetName}"을 screenshot으로 변환했습니다.`
        );

      } else if (
        tx.attempted
      ) {
        stats.screenshotRejected++;
        stats.preservedAreas++;


        const restored =
          findByPluginData(
            state.root,
            "slc_current_op",
            marker
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
          tx.reason ===
            "visual-changed"
            ? "screenshot 변환 후 Render가 달라져 원래 구조를 유지했습니다."
            : `screenshot 변환 실패: ${tx.reason}`
        );
      }
    }


    if (!acceptedAny) {
      break;
    }
  }
}


/* =========================================================
   VISUAL PROPERTIES
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
        paint.visible ===
        false
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
  try {
    if (
      "fills" in node &&
      node.fills !==
        figma.mixed &&
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
      node.strokes !==
        figma.mixed &&
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


  /*
   * Mask / 실제 Clip은 앞 단계에서
   * screenshot 시도.
   *
   * 실패했다면 Flatten하지 않는다.
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


  /*
   * 가장 깊은 Container부터.
   */
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
        "parent-invalid"
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
   * 빈 Frame은 그냥 제거 시도.
   */
  if (
    children.length === 0
  ) {
    return {
      root,
      changed:
        safeRemove(container),

      reason:
        "empty-container"
    };
  }


  /*
   * 폰트 Load 선행.
   */
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


  let insertIndex =
    index;


  /*
   * Frame 자체의 배경/Stroke 등을
   * shape로 유지.
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
        insertIndex
      );


    if (shell) {
      insertIndex++;
    }
  }


  let moved =
    0;


  for (
    const item of
    snapshots
  ) {
    const child =
      item.child;


    /*
     * Parent Auto Layout이라면
     * 기존 절대 위치를 유지하기 위해
     * Absolute child로 올려본다.
     *
     * 잘못되면 Transaction에서 자동 Rollback.
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
      insertIndex,
      child
    );


    child.relativeTransform =
      absoluteToRelative(
        item.transform,
        parent
      );


    insertIndex++;
    moved++;
  }


  if (
    childrenOf(container)
      .length !== 0
  ) {
    return {
      root,
      changed:
        false,
      reason:
        "children-remain"
    };
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
      1
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
    const candidates =
      collectFlattenCandidates(
        state.root
      );


    if (
      candidates.length === 0
    ) {
      break;
    }


    let acceptedAny =
      false;


    for (
      const item of
      candidates
    ) {
      const target =
        item.node;


      if (!isAlive(target)) {
        continue;
      }


      const marker =
        `flatten_${Date.now()}_${Math.random()}`;


      setPD(
        target,
        "slc_current_op",
        marker
      );


      const targetName =
        safeName(target);

      const targetType =
        safeType(target);


      const tx =
        await runVisualTransaction(
          state,

          async root => {
            const container =
              findByPluginData(
                root,
                "slc_current_op",
                marker
              );


            if (!container) {
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
              container
            );
          }
        );


      if (
        tx.accepted
      ) {
        acceptedAny =
          true;

        stats.removedContainers++;
        stats.flattenedContainers++;


        stats.movedLayers +=
          tx.data &&
          tx.data.moved
            ? tx.data.moved
            : 0;


        addReport(
          stats,
          "Container Flatten",
          "SUCCESS",
          null,
          `${targetType} "${targetName}"을 한 단계 제거했습니다.`
        );

      } else if (
        tx.attempted
      ) {
        stats.flattenRejected++;
        stats.preservedAreas++;


        const restored =
          findByPluginData(
            state.root,
            "slc_current_op",
            marker
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
          tx.reason ===
            "visual-changed"
            ? "Frame/Group을 해제하면 실제 Render가 달라져 해당 Container만 유지했습니다."
            : `Container를 풀지 못했습니다: ${
                tx.data &&
                tx.data.reason
                  ? tx.data.reason
                  : tx.reason
              }`
        );

      } else {
        const restored =
          findByPluginData(
            state.root,
            "slc_current_op",
            marker
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
          "SKIPPED",
          restored,
          tx.data &&
          tx.data.reason
            ? tx.data.reason
            : tx.reason
        );
      }
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
   * Root Instance 먼저 Detach.
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
    parent.children.indexOf(
      root
    );


  const rootTransform =
    safeTransform(root);


  if (!rootTransform) {
    return {
      root,
      changed:
        false,
      reason:
        "root-transform-unavailable"
    };
  }


  const width =
    root.width;

  const height =
    root.height;


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
      rootTransform,
      parent
    );


  /*
   * Root 자체 Visual이 있으면
   * Frame에 최대한 복제.
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
    return;
  }


  const oldType =
    safeType(state.root);


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
      `${oldType} 최상위를 Frame으로 변환했습니다.`
    );

  } else if (
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
        ? "Frame 변환 후 Render가 달라져 기존 최상위 구조를 유지했습니다."
        : `Frame 변환 실패: ${tx.reason}`
    );

  } else {
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
    value.includes("light")
  ) {
    style =
      "Light";
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


async function loadInterStyle(
  style
) {
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
    const sourceStyle =
      segment.fontName &&
      segment.fontName !==
        figma.mixed
        ? segment.fontName.style
        : "Regular";


    const targetStyle =
      await loadInterStyle(
        mapInterStyle(
          sourceStyle
        )
      );


    if (!targetStyle) {
      continue;
    }


    node.setRangeFontName(
      segment.start,
      segment.end,
      {
        family:
          "Inter",

        style:
          targetStyle
      }
    );


    converted++;
  }


  return converted;
}


/* =========================================================
   INTER PROCESS
========================================================= */

async function processInter(
  state,
  stats
) {
  if (!convertFontToInter) {
    return;
  }


  /*
   * Text마다 별도 검증.
   */
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
          "slc_inter_done"
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


    const marker =
      `inter_${Date.now()}_${Math.random()}`;


    setPD(
      target,
      "slc_current_op",
      marker
    );


    const tx =
      await runVisualTransaction(
        state,

        async root => {
          const text =
            findByPluginData(
              root,
              "slc_current_op",
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


          if (
            count <= 0
          ) {
            setPD(
              text,
              "slc_inter_done",
              "1"
            );


            return {
              root,
              changed:
                false,
              reason:
                "font-conversion-unavailable"
            };
          }


          setPD(
            text,
            "slc_inter_done",
            "1"
          );


          return {
            root,

            changed:
              true,

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
        tx.data.converted ||
        0;


      addReport(
        stats,
        "Font → Inter",
        "SUCCESS",
        null,
        "Inter 변환 후 화면 Render가 동일하여 적용했습니다."
      );

    } else if (
      tx.attempted
    ) {
      stats.failedFontConversions++;


      const restored =
        findByPluginData(
          state.root,
          "slc_current_op",
          marker
        );


      if (restored) {
        setPD(
          restored,
          "slc_inter_done",
          "1"
        );
      }


      addReport(
        stats,
        "Font → Inter",
        "REJECTED",
        restored,
        tx.reason ===
          "visual-changed"
          ? "Inter 적용 시 실제 글자 Render가 달라져 기존 Font를 유지했습니다."
          : `Inter 변환 실패: ${tx.reason}`
      );

    } else {
      const restored =
        findByPluginData(
          state.root,
          "slc_current_op",
          marker
        );


      if (restored) {
        setPD(
          restored,
          "slc_inter_done",
          "1"
        );
      }
    }
  }
}


/* =========================================================
   NAMING
========================================================= */

function looksLikeIcon(node) {
  const type =
    safeType(node);


  const name =
    safeName(node)
      .toLowerCase();


  if (
    type === "VECTOR" ||
    type ===
      "BOOLEAN_OPERATION" ||
    type === "POLYGON" ||
    type === "STAR"
  ) {
    return true;
  }


  if (
    type === "ELLIPSE"
  ) {
    return (
      name.includes("icon") ||
      name.includes("ic_") ||
      name.startsWith("ic/")
    );
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
      "screen shot"
    ) ||
    name.includes(
      "스크린샷"
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
   * TEXT
   */
  if (
    type === "TEXT"
  ) {
    if (
      isLidName(current)
    ) {
      return current;
    }


    return renameTextToHyphen
      ? "-"
      : current;
  }


  if (
    type === "LINE"
  ) {
    return "line";
  }


  if (
    looksLikeIcon(node)
  ) {
    return "icon";
  }


  if (
    type === "RECTANGLE"
  ) {
    if (
      hasImageFill(node)
    ) {
      return looksLikeScreenshot(
        node,
        root
      )
        ? "screenshot"
        : "image";
    }


    return "shape";
  }


  if (
    type === "ELLIPSE"
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


    const desired =
      desiredLayerName(
        node,
        root
      );


    if (
      desired !== null &&
      desired !==
        safeName(node)
    ) {
      try {
        node.name =
          desired;


        stats.renamedLayers++;

      } catch (error) {
        stats.renameSkipped++;


        addReport(
          stats,
          "Layer Rename",
          "REJECTED",
          node,
          "Figma에서 해당 Layer의 이름 변경을 허용하지 않았습니다."
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
   LAYER ORDER
========================================================= */

function spatialBounds(node) {
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
      bounds.height
  };
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
    a.x + a.width <=
      b.x ||

    b.x + b.width <=
      a.x ||

    a.y + a.height <=
      b.y ||

    b.y + b.height <=
      a.y
  );
}


function compareSpatial(
  a,
  b
) {
  if (
    !a.bounds ||
    !b.bounds
  ) {
    return (
      a.oldPanelIndex -
      b.oldPanelIndex
    );
  }


  const ay =
    a.bounds.y +
    a.bounds.height / 2;


  const by =
    b.bounds.y +
    b.bounds.height / 2;


  /*
   * 같은 높이 → 좌 → 우
   */
  if (
    Math.abs(
      ay - by
    ) <= ROW_TOLERANCE
  ) {
    const dx =
      a.bounds.x -
      b.bounds.x;


    if (
      Math.abs(dx) >
      0.1
    ) {
      return dx;
    }
  }


  /*
   * 위 → 아래
   */
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
    a.oldPanelIndex -
    b.oldPanelIndex
  );
}


async function reorderRootLayers(
  root
) {
  /*
   * Root Auto Layout에서는
   * children order 자체가 Layout 의미이므로
   * 변경하지 않는다.
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
    [...children]
      .reverse();


  const items =
    panelOrder.map(
      (node, index) => ({
        node,

        bounds:
          spatialBounds(node),

        oldPanelIndex:
          index,

        outgoing:
          new Set(),

        indegree:
          0
      })
    );


  /*
   * 겹치는 Layer의 Z-order는 유지.
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


  const desiredPanel =
    [];


  while (
    available.length > 0
  ) {
    available.sort(
      compareSpatial
    );


    const current =
      available.shift();


    desiredPanel.push(
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
    desiredPanel.length !==
    items.length
  ) {
    return {
      root,
      changed:
        false,
      reason:
        "order-constraint-cycle"
    };
  }


  const desiredChildren =
    desiredPanel
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
    i <
      desiredChildren.length;
    i++
  ) {
    root.insertChild(
      i,
      desiredChildren[i]
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
      "Root Layer를 화면상 위→아래, 같은 줄은 좌→우 순으로 정리했습니다."
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
      tx.reason ===
        "visual-changed"
        ? "Layer 순서 변경 시 실제 화면 Z-order가 달라져 기존 순서를 유지했습니다."
        : `Layer 순서를 변경하지 못했습니다: ${tx.reason}`
    );

  } else if (
    tx.data &&
    tx.data.reason ===
      "root-auto-layout"
  ) {
    addReport(
      stats,
      "Layer Order",
      "SKIPPED",
      state.root,
      "최상위가 Auto Layout이라 children 순서 변경이 실제 Layout을 변경할 수 있어 기존 순서를 유지했습니다."
    );
  }
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
      actuallyClipsChildren(
        node
      )
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
      safeType(node) ===
      "LINE"
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
   FINAL VISUAL CHECK
========================================================= */

async function finalVisualCheck(
  originalRoot,
  state
) {
  const original =
    await exportNodePng(
      originalRoot
    );


  const final =
    await exportNodePng(
      state.root
    );


  return (
    original &&
    final &&
    sameBytes(
      original,
      final
    )
  );
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


  let index =
    parent.children.indexOf(
      original
    );


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
        "선택 Screen이 Page 직속 Layer가 아니어서 안전하게 교체할 수 없습니다."
    };
  }


  /* =====================================================
     1. WORKING COPY
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
        error.message
    };
  }


  /* =====================================================
     2. GARBAGE MARK
  ===================================================== */

  markSelectedGarbage(
    originalRoot,
    state.root
  );


  /* =====================================================
     3. GARBAGE
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
     6. MASK / REAL CLIP
  ===================================================== */

  await processScreenshots(
    state,
    stats
  );


  /* =====================================================
     7. FRAME / GROUP / AUTOLAYOUT FLATTEN
  ===================================================== */

  await processFlatten(
    state,
    stats
  );


  /* =====================================================
     8. INTER
  ===================================================== */

  await processInter(
    state,
    stats
  );


  /* =====================================================
     9. NAMING
     이름은 Visual에 영향을 주지 않으므로
     전체 적용.
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
    `${stats.renamedLayers}개 Layer 이름 정리 완료 / ${stats.renameSkipped}개 변경 실패`
  );


  /* =====================================================
     10. ORDER
  ===================================================== */

  await processOrder(
    state,
    stats
  );


  /* =====================================================
     11. INTERNAL DATA 제거
  ===================================================== */

  clearInternalPluginData(
    state.root
  );


  /* =====================================================
     12. FINAL VISUAL VERIFICATION
  ===================================================== */

  const visualPass =
    await finalVisualCheck(
      originalRoot,
      state
    );


  if (!visualPass) {
    /*
     * 이건 정상적으로는 나오면 안 된다.
     *
     * 모든 위험 작업을 개별 검증했기 때문.
     *
     * 그래도 최종 결과가 다르면
     * 제1법칙 때문에 원본 유지.
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
        "최종 Render 검증에서 원본과 차이가 감지되었습니다. 안전을 위해 작업본 전체를 폐기하고 원본을 유지했습니다."
    };
  }


  /* =====================================================
     13. COMMIT
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
      success:
        false,

      root:
        originalRoot,

      stats,

      fatalReason:
        "작업 결과를 원래 Screen 위치에 안전하게 적용하지 못했습니다."
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
   ANALYZED ROOT RESOLUTION
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
   UI
========================================================= */

figma.ui.onmessage =
async msg => {


  /* =====================================================
     CLOSE
  ===================================================== */

  if (
    msg.type ===
    "close"
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


      /*
       * Selection은 바뀌지만
       * analyzedRootIds는 유지된다.
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
    msg.type ===
    "analyze"
  ) {
    const selection =
      [
        ...figma.currentPage
          .selection
      ].filter(
        node =>
          isAlive(node)
      );


    if (
      selection.length ===
      0
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
     * ★ Analyze Root 고정
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
     * Analyze를 안 했을 경우에만
     * 현재 Selection 사용.
     */
    if (
      analyzedRootIds.length ===
      0
    ) {
      analyzedRootIds =
        [
          ...figma.currentPage
            .selection
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
          "Analyze한 Screen을 찾을 수 없습니다. Screen을 다시 선택하고 Analyze Screen을 실행해주세요."
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

      screenshotBaked: 0,
      screenshotRejected: 0,

      flattenedContainers: 0,
      flattenRejected: 0,

      rootConverted: 0,
      rootConversionRejected: 0,

      convertedTexts: 0,
      convertedFontSegments: 0,
      failedFontConversions: 0,

      renamedLayers: 0,
      renameSkipped: 0,

      orderChanged: 0,
      orderRejected: 0,

      finalLayers: 0,

      /*
       * 기존 UI 호환
       */
      preservedAreas: 0,
      visualShells: 0,
      bakedAreas: 0,

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
            total.failureReasons.push(
              {
                screen:
                  safeName(root),

                reason:
                  result.fatalReason
              }
            );
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


      /*
       * 새 Root ID 저장.
       */
      analyzedRootIds =
        aliveRoots
          .map(
            root =>
              safeId(root)
          )
          .filter(Boolean);
    }


    /*
     * UI가 extra fields를 사용한다면
     * 상세 Report까지 표시 가능.
     *
     * 기존 UI는 기존 필드만 읽어도 문제 없음.
     */
    figma.ui.postMessage({
      type:
        "complete",

      result:
        total
    });


    /*
     * Console 상세 Report
     */
    console.log(
      "===================================="
    );

    console.log(
      "SCREEN LAYER CLEANER REPORT"
    );

    console.log(
      "===================================="
    );


    console.log(
      "Deleted Garbage:",
      total.removedGarbage
    );

    console.log(
      "Protected Garbage:",
      total.protectedGarbage
    );

    console.log(
      "Detached Instances:",
      total.detachedInstances
    );

    console.log(
      "Rejected Instances:",
      total.rejectedInstances
    );

    console.log(
      "Flattened Containers:",
      total.flattenedContainers
    );

    console.log(
      "Rejected Flatten:",
      total.flattenRejected
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
      "Text → Inter:",
      total.convertedTexts
    );

    console.log(
      "Order Changed:",
      total.orderChanged
    );


    console.table(
      total.report
    );


    if (
      total.failureReasons.length >
      0
    ) {
      console.error(
        "Fatal Failures:",
        total.failureReasons
      );
    }


    if (
      total.rolledBack === 0
    ) {
      figma.notify(
        `Cleanup 완료 · Garbage ${total.removedGarbage} · Flatten ${total.flattenedContainers} · Rename ${total.renamedLayers}`
      );

    } else {
      figma.notify(
        `Cleanup 완료 · ${total.committed}개 적용 / ${total.rolledBack}개 Screen은 최종 안전검사로 원본 유지`
      );
    }


    return;
  }
};
