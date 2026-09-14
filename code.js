figma.showUI(__html__, {
  width: 440,
  height: 760,
  themeColors: true
});


/* =========================================================
   SCREEN LAYER CLEANER
   STABLE VISUAL-PRESERVATION VERSION

   ---------------------------------------------------------
   제1법칙
   ---------------------------------------------------------
   디자인 화면의 실제 Render 결과를 변경하지 않는다.

   위험 작업:
   - Garbage 삭제
   - Instance Detach
   - Root → Frame
   - Mask / Clip Bake
   - Frame / Group / Auto Layout Flatten
   - Layer Order
   - Font → Inter

   모두 작업용 Clone에서 실행.

   작업 전후 Screen PNG가 동일:
     → 작업 확정

   달라짐:
     → 해당 작업만 Rollback

   Naming:
     → Visual에 영향이 없으므로 직접 적용

========================================================= */


/* =========================================================
   GLOBAL
========================================================= */

let renameTextToHyphen = false;
let convertFontToInter = false;

let approvedGarbageIds = new Set();

/*
 * Analyze Screen을 누른 시점의 Root.
 *
 * Garbage "보기"를 눌러 Canvas selection이 바뀌어도
 * 실제 Clean 대상은 유지한다.
 */
let analyzedRootIds = [];


const WORK_OFFSET_X = 30000;
const CHECKPOINT_OFFSET_X = 60000;

const ROW_Y_TOLERANCE = 6;

const MAX_INSTANCE_PASSES = 10;
const MAX_SCREENSHOT_PASSES = 10;
const MAX_FLATTEN_PASSES = 30;


/* =========================================================
   INTERNAL PLUGIN DATA
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

    /*
     * 기존 UI 호환
     */
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
  function walk(node) {
    if (!isAlive(node)) {
      return;
    }


    const keys = [
      PD_GARBAGE_ID,
      PD_CURRENT_OP,
      PD_SKIP_DETACH,
      PD_SKIP_SCREENSHOT,
      PD_SKIP_FLATTEN,
      PD_INTER_DONE
    ];


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
   PATH
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
   WORKING COPY
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
      "원본 Screen PNG 생성 실패"
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


  const clonedPng =
    await exportNodePng(
      clone
    );


  if (
    !clonedPng ||
    !sameBytes(
      baseline,
      clonedPng
    )
  ) {
    safeRemove(clone);


    throw new Error(
      "작업용 Clone이 원본과 동일하게 렌더되지 않습니다."
    );
  }


  return {
    root:
      clone,

    baseline
  };
}


/* =========================================================
   VISUAL TRANSACTION
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
      accepted:
        false,

      attempted:
        false,

      reason:
        "working-root-missing"
    };
  }


  const workRoot =
    state.root;


  const workX =
    workRoot.x;

  const workY =
    workRoot.y;


  let checkpoint =
    null;


  try {
    checkpoint =
      workRoot.clone();


    figma.currentPage.appendChild(
      checkpoint
    );


    checkpoint.x =
      workX +
      CHECKPOINT_OFFSET_X;


    checkpoint.y =
      workY;

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
        workRoot
      );

  } catch (error) {

    /*
     * 해당 Operation Rollback.
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
      workX;

    checkpoint.y =
      workY;


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


  if (
    after &&
    sameBytes(
      state.baseline,
      after
    )
  ) {
    /*
     * 제1법칙 통과.
     */
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
   * 제1법칙 위반.
   * 이번 Operation만 취소.
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
    workX;

  checkpoint.y =
    workY;


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
    safeType(node) === "SLICE"
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
   COUNT SELECTED GARBAGE IN SUBTREE
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

    let depthFound =
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
        depth < depthFound
      ) {
        target =
          node;

        depthFound =
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


    const garbageName =
      safeName(target);

    const garbageType =
      safeType(target);

    const reason =
      getGarbageReason(target);

    const deletedCount =
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
                "garbage-not-found"
            };
          }


          return {
            root,

            changed:
              safeRemove(current),

            reason:
              "garbage-delete"
          };
        }
      );


    if (
      tx.accepted
    ) {
      stats.removedGarbage +=
        deletedCount;


      addReport(
        stats,
        "Garbage Delete",
        "SUCCESS",
        null,
        `${garbageType} "${garbageName}" 삭제 완료 (${reason})`
      );

    } else {
      stats.protectedGarbage +=
        deletedCount;


      /*
       * Rollback Root에서 다시 찾은 뒤
       * 반복 시도 방지.
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
          ? "삭제하면 실제 화면 Render가 변경되어 해당 Garbage만 유지했습니다."
          : `삭제 실패: ${tx.reason}`
      );
    }
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


async function ensureTextFontsLoaded(
  node
) {
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


async function ensureSubtreeFontsLoaded(
  node
) {
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
   INSTANCE
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


      /*
       * Instance 자체부터 Detach하고
       * 그 내부는 다음 Pass에서 확인.
       */
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


      const originalName =
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
          `"${originalName}" Instance 해제 완료`
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
          tx.reason ===
            "visual-changed"
            ? "Detach 시 실제 Render가 달라져 Instance를 유지했습니다."
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


  const parentBounds =
    safeBounds(node);


  if (!parentBounds) {
    return true;
  }


  const left =
    parentBounds.x;

  const top =
    parentBounds.y;

  const right =
    parentBounds.x +
    parentBounds.width;

  const bottom =
    parentBounds.y +
    parentBounds.height;


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


    const bounds =
      safeRenderBounds(child);


    if (!bounds) {
      continue;
    }


    if (
      bounds.x <
        left - 0.5 ||

      bounds.y <
        top - 0.5 ||

      bounds.x +
        bounds.width >
        right + 0.5 ||

      bounds.y +
        bounds.height >
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
   SCREENSHOT BAKE
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


      const originalName =
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
          `"${originalName}" → screenshot`
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


        addReport(
          stats,
          "Mask / Clip",
          "REJECTED",
          restored,
          tx.reason ===
            "visual-changed"
            ? "Screenshot 변환 시 Render 차이가 발생해 기존 구조를 유지했습니다."
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
   * Mask / 실제 Clip 구조는
   * screenshot 단계에서 처리.
   *
   * 실패한 경우 강제 Flatten하지 않는다.
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
  if (
    !isAlive(container)
  ) {
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
   * Empty Container.
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
        1
    };
  }


  /*
   * Font 문제 사전 차단.
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
   * Container 자체의 Visual을 Shape로 보존.
   */
  if (
    hasOwnVisual(container)
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
     * Parent가 Auto Layout이면
     * 기존 좌표를 지키기 위해 Absolute 배치 시도.
     *
     * 실패하거나 화면이 달라지면
     * Transaction에서 자동 복원.
     */
    try {
      if (
        isAutoLayout(parent) &&
        "layoutPositioning" in child
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
          `${nodeType} "${nodeName}" 한 단계 해제 완료`
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
          tx.reason ===
            "visual-changed"
            ? "Container 해제 시 실제 Render가 변경되어 해당 구조만 유지했습니다."
            : `Flatten 실패: ${
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
      `${beforeType} 최상위를 Frame으로 변환했습니다.`
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
        ? "Root를 Frame으로 교체하면 Render가 변경되어 기존 Root를 유지했습니다."
        : `Root 변환 실패: ${tx.reason}`
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
    loadedInterStyles.has(style)
  ) {
    return style;
  }


  try {
    await figma.loadFontAsync({
      family:
        "Inter",

      style
    });


    loadedInterStyles.add(style);


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
      const segment of segments
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


      /*
       * 이미 Inter라면 Skip.
       */
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


    const oldName =
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
        `"${oldName}" Inter 변환 완료`
      );

    } else if (
      tx.attempted
    ) {
      stats.failedFontConversions++;


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


      addReport(
        stats,
        "Font → Inter",
        "REJECTED",
        restored,
        tx.reason ===
          "visual-changed"
          ? "Inter로 변경하면 실제 글자 Render가 달라져 기존 Font를 유지했습니다."
          : `Inter 변환 실패: ${tx.reason}`
      );

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


  /*
   * 이름상 명확한 Icon이면
   * Instance / Component / Frame이어도 icon.
   */
  if (
    looksLikeIconName(
      name
    )
  ) {
    return true;
  }


  if (
    type === "VECTOR" ||
    type === "BOOLEAN_OPERATION" ||
    type === "POLYGON" ||
    type === "STAR"
  ) {
    return true;
  }


  if (
    type === "ELLIPSE" &&
    looksLikeIconName(name)
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


  /*
   * 얇은 Rectangle/Vector Divider도 line으로.
   */
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
      const w =
        node.width;

      const h =
        node.height;


      if (
        w >= 8 &&
        h <= 2
      ) {
        return true;
      }


      if (
        h >= 8 &&
        w <= 2
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
   * LID는 어떤 Layer Type이든 최우선 보호.
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
   * Screenshot
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
   * Line을 Icon보다 먼저 확인.
   */
  if (
    looksLikeLine(node)
  ) {
    return "line";
  }


  /*
   * Icon.
   */
  if (
    looksLikeIcon(node)
  ) {
    return "icon";
  }


  /*
   * Shape.
   */
  if (
    type === "RECTANGLE" ||
    type === "ELLIPSE" ||
    type === "POLYGON" ||
    type === "STAR" ||
    type === "BOOLEAN_OPERATION" ||
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


    const desired =
      desiredLayerName(
        node,
        root
      );


    if (
      desired !== null &&
      desired !== safeName(node)
    ) {
      try {
        node.name =
          desired;


        stats.renamedLayers++;

      } catch (_) {
        stats.renameSkipped++;


        addReport(
          stats,
          "Layer Rename",
          "REJECTED",
          node,
          "Figma가 해당 Layer의 Name 변경을 허용하지 않았습니다."
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
   ORDER V2
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
   * Top Y가 비슷.
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


function orderBoundsOverlap(
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
   BUILD VISUAL ROWS
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


    let selectedRow =
      null;


    /*
     * 같은 행 탐색.
     *
     * Row의 첫 요소만 보는 방식보다 안정적으로,
     * Row 내부 요소 중 하나라도 같은 Visual Row면 묶는다.
     */
    for (
      const row of rows
    ) {
      if (
        row.items.some(
          existing =>
            existing.bounds &&
            isSameVisualRow(
              existing.bounds,
              item.bounds
            )
        )
      ) {
        selectedRow =
          row;

        break;
      }
    }


    if (!selectedRow) {
      selectedRow = {
        y:
          item.bounds.y,

        items:
          []
      };


      rows.push(
        selectedRow
      );
    }


    selectedRow.items.push(
      item
    );


    selectedRow.y =
      Math.min(
        selectedRow.y,
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
   * 같은 행은 좌 → 우.
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
   TOPOLOGICAL Z-ORDER SORT
========================================================= */

/*
 * 원하는 순서:
 * 위 → 아래 / 좌 → 우
 *
 * 단,
 * 실제로 겹치는 Layer끼리는 현재 Z-order를
 * 절대 뒤집지 않는다.
 */
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


  const desired =
    [];


  for (
    const row of rows
  ) {
    desired.push(
      ...row.items
    );
  }


  desired.forEach(
    (item, index) => {
      item.desiredRank =
        index;
    }
  );


  /*
   * 겹치는 Layer끼리는 현재 Panel 순서 Constraint.
   *
   * i가 현재 더 위에 있으면
   * i → j edge.
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
        orderBoundsOverlap(
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


  /*
   * Topological Sort.
   *
   * 동시에 선택 가능한 Node 중
   * 원하는 위치순 Rank가 가장 빠른 걸 먼저 선택.
   */
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


  /*
   * 혹시 Cycle 발생.
   */
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
   * Root Auto Layout에서는
   * Child Order = Layout Order.
   *
   * Layer Panel을 바꾸려고 실제 Canvas 위치가 바뀌면 안 되므로
   * 여기서는 건드리지 않는다.
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


  const desiredPanel =
    buildSafeDesiredPanelOrder(
      root
    );


  if (!desiredPanel) {
    return {
      root,

      changed:
        false,

      reason:
        "z-order-cycle"
    };
  }


  /*
   * Panel order와 children 배열은 반대.
   */
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
      "Layer Panel을 화면 기준 위→아래, 같은 행은 좌→우로 정렬했습니다."
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
        ? "정렬 과정에서 실제 Z-order Render가 달라져 기존 Layer 순서를 유지했습니다."
        : `Layer 정렬 실패: ${tx.reason}`
    );


    return;
  }


  const reason =
    tx.data &&
    tx.data.reason
      ? tx.data.reason
      : tx.reason;


  if (
    reason ===
    "root-auto-layout"
  ) {
    addReport(
      stats,
      "Layer Order",
      "SKIPPED",
      state.root,
      "최상위 Frame이 Auto Layout이라 Child 순서 변경 시 실제 화면 배치가 달라질 수 있어 정렬하지 않았습니다."
    );

  } else {
    addReport(
      stats,
      "Layer Order",
      "SKIPPED",
      state.root,
      reason
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


  /*
   * 작업 결과를 안전하게 교체하려면
   * 현재 안정 버전에서는 Page 직속 Screen이어야 한다.
   */
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
        "선택한 Screen이 Page 직속 Layer가 아닙니다. 상위 Screen을 선택해주세요."
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
        error &&
        error.message
          ? error.message
          : String(error)
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
     3. GARBAGE DELETE
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
     6. MASK / CLIP → SCREENSHOT
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
     8. FONT → INTER
  ===================================================== */

  await processInter(
    state,
    stats
  );


  /* =====================================================
     9. NAMING
     이름은 Screen Render에 영향 없음.
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
    `${stats.renamedLayers}개 Layer 이름 변경 / ${stats.renameSkipped}개 변경 실패`
  );


  /* =====================================================
     10. ORDER
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
     12. FINAL VISUAL CHECK
  ===================================================== */

  const visualPass =
    await finalVisualCheck(
      originalRoot,
      state
    );


  if (!visualPass) {
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
        "최종 Render 검증에서 원본과 차이가 발견되었습니다. 제1법칙에 따라 작업본 전체를 폐기하고 원본을 유지했습니다."
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
        node.type === "DOCUMENT" ||
        node.type === "PAGE"
      ) {
        return;
      }


      /*
       * Canvas Selection만 바뀐다.
       *
       * 실제 Clean Root는
       * analyzedRootIds에 따로 저장되어 있음.
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
     * Analyze Root 고정.
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
     * Analyze를 거치지 않은 경우에만
     * 현재 Selection 사용.
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

      /*
       * 기존 UI 호환
       */
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


      /*
       * 다음 Clean에서도
       * 새 Root를 유지.
       */
      analyzedRootIds =
        aliveRoots
          .map(
            root =>
              safeId(root)
          )
          .filter(Boolean);
    }


    /* =====================================================
       RESULT
    ===================================================== */

    figma.ui.postMessage({
      type:
        "complete",

      result:
        total
    });


    /* =====================================================
       CONSOLE REPORT
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
      "Garbage Protected:",
      total.protectedGarbage
    );


    console.log(
      "Instance Detached:",
      total.detachedInstances
    );


    console.log(
      "Instance Preserved:",
      total.rejectedInstances
    );


    console.log(
      "Flattened Containers:",
      total.flattenedContainers
    );


    console.log(
      "Flatten Preserved:",
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
      "Font → Inter:",
      total.convertedTexts
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
        "Fatal failures:",
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
