figma.showUI(__html__, {
  width: 440,
  height: 760,
  themeColors: true
});


/* =========================================================
   SCREEN LAYER CLEANER
   Batch + Binary Isolation
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

const MAX_INSTANCE_ROUNDS = 2;


/* =========================================================
   PLUGIN DATA
========================================================= */

const PD_GARBAGE_ID =
  "slc_garbage_id";

const PD_TASK_ID =
  "slc_task_id";

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
      node &&
      isAlive(node)
        ? safeName(node)
        : "",

    type:
      node &&
      isAlive(node)
        ? safeType(node)
        : "",

    reason:
      reason || ""
  };


  stats.report.push(
    entry
  );


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

    return (

      isAlive(node) &&

      "children" in node

        ? [...node.children]

        : []
    );

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

  try {

    if (
      !isAlive(node)
    ) {

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

      node.layoutMode !==
        "NONE"
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

      node.layoutPositioning ===
        "ABSOLUTE"
    );

  } catch (_) {

    return true;
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


  if (
    !parentTransform
  ) {

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

    return isAlive(node)

      ? (
          node.getPluginData(key) ||
          ""
        )

      : "";

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

    if (
      isAlive(node)
    ) {

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

    if (
      !isAlive(node)
    ) {

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
   TASK MARKER
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

    if (
      !isAlive(node)
    ) {

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


    if (
      !isAlive(current)
    ) {

      return null;
    }
  }


  return current;
}


/* =========================================================
   PNG
========================================================= */

async function exportNodePng(node) {

  if (
    !isAlive(node)
  ) {

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

      accepted:
        false,

      attempted:
        false,

      reason:
        "empty-batch",

      results:
        []
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


  if (
    !before
  ) {

    return {

      accepted:
        false,

      attempted:
        false,

      reason:
        "before-render-failed",

      results:
        []
    };
  }


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

      accepted:
        false,

      attempted:
        false,

      reason:
        "checkpoint-create-failed",

      results:
        [],

      error
    };
  }


  const results =
    [];


  let changedAny =
    false;


  try {

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

          changed:
            false,

          reason:
            "operation-error",

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
        isAlive(
          result.root
        )
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

      accepted:
        false,

      attempted:
        true,

      reason:
        "batch-operation-error",

      results,

      error
    };
  }


  if (
    !changedAny
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
        "no-change",

      results
    };
  }


  const after =
    await exportNodePng(
      state.root
    );


  if (
    !after
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
        "after-render-failed",

      results
    };
  }


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

      accepted:
        true,

      attempted:
        true,

      reason:
        "visual-identical",

      results
    };
  }


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

    results
  };
}


/* =========================================================
   BINARY ISOLATION
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


  if (
    tx.accepted
  ) {

    const map =
      new Map(

        tx.results.map(
          item => [
            item.task.marker,
            item
          ]
        )
      );


    for (
      const task of tasks
    ) {

      const result =
        map.get(
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

            reason:
              "no-change"
          }
        );
      }
    }


    return;
  }


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


  if (
    tasks.length === 1
  ) {

    await onRejected(
      tasks[0],
      tx
    );


    return;
  }


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

    applyTask,

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

    applyTask,

    stats,

    onAccepted,
    onRejected,
    onSkipped
  });
}


async function runSingleVisualTransaction(
  state,
  mutate,
  stats
) {

  return await runVisualBatchTransaction(

    state,

    [
      {

        marker:
          createTaskMarker(
            "single"
          )
      }
    ],

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
   VISUAL PROPERTIES
========================================================= */

function hasVisiblePaint(paints) {

  return (

    Array.isArray(paints) &&

    paints.some(
      paint =>

        paint.visible !==
          false &&

        !(
          typeof paint.opacity ===
            "number" &&

          paint.opacity ===
            0
        )
    )
  );
}


function hasVisibleFill(node) {

  try {

    return (

      "fills" in node &&

      node.fills !==
        figma.mixed &&

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

      node.strokes !==
        figma.mixed &&

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
          effect.visible !==
          false
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

      node.fills !==
        figma.mixed &&

      Array.isArray(
        node.fills
      ) &&

      node.fills.some(
        fill =>

          fill.type ===
            "IMAGE" &&

          fill.visible !==
            false
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

      node.isMask ===
        true
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

      node.clipsContent !==
        true
    ) {

      return false;
    }

  } catch (_) {

    return false;
  }


  const box =
    safeBounds(node);


  if (
    !box
  ) {

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

        child.visible ===
          false
      ) {

        continue;
      }

    } catch (_) {}


    const childBox =
      safeRenderBounds(child);


    if (
      !childBox
    ) {

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

      node.width <=
        0.1 ||

      node.height <=
        0.1
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

    childrenOf(node).length ===
      0 &&

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

      node.visible ===
        false
    ) {

      return (
        "Hidden · visible=false"
      );
    }

  } catch (_) {}


  try {

    if (

      "opacity" in node &&

      node.opacity ===
        0
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

    return "Slice";
  }


  if (
    isTinyNode(node)
  ) {

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

    participatesInAutoLayout(
      node
    )
  ) {

    return false;
  }


  try {

    if (

      "visible" in node &&

      node.visible ===
        false
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

        root.clipsContent ===
          true
      ) {

        return true;
      }

    } catch (_) {}
  }


  return false;
}


function collectGarbageItems(root) {

  const result =
    [];


  function walk(
    node,
    path
  ) {

    if (
      !isAlive(node)
    ) {

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


    if (
      !path
    ) {

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


function buildGarbageTasks(root) {

  const result =
    [];


  function countMarked(node) {

    let count =
      0;


    function walk(current) {

      if (
        !isAlive(current)
      ) {

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

    if (
      !isAlive(node)
    ) {

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


  for (
    const task of
    fastTasks
  ) {

    const node =
      findByPluginData(

        state.root,

        PD_TASK_ID,

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

        `${task.type} "${task.name}" · ${task.reason} · Fast`
      );
    }
  }


  await processBatchWithIsolation({

    state,

    tasks:
      riskyTasks,

    stats,


    applyTask:
      async (
        root,
        task
      ) => {

        const node =
          findByPluginData(

            root,

            PD_TASK_ID,

            task.marker
          );


        if (
          !node
        ) {

          return {

            root,

            changed:
              false,

            reason:
              "garbage-missing"
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
      async (
        task,
        tx
      ) => {

        stats.protectedGarbage +=
          task.count;


        const restored =
          findByPluginData(

            state.root,

            PD_TASK_ID,

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

        segment.fontName &&

        segment.fontName !==
          figma.mixed &&

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

  if (
    !isAlive(node)
  ) {

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
   FLATTEN CANDIDATES
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

    !actuallyClipsChildren(
      node
    ) &&

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

    participatesInAutoLayout(
      node
    ) ||

    containsMask(node) ||

    actuallyClipsChildren(
      node
    ) ||

    hasOwnVisual(node)
  ) {

    return false;
  }


  try {

    if (

      "opacity" in node &&

      node.opacity !==
        1
    ) {

      return false;
    }

  } catch (_) {}


  try {

    if (

      "rotation" in node &&

      Math.abs(
        node.rotation
      ) >
        0.001
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
   EXECUTION PLAN
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
    depth
  ) {

    if (
      !isAlive(node)
    ) {

      return;
    }


    const type =
      safeType(node);


    if (

      type ===
        "INSTANCE" &&

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
      node === root
    ) {

      return;
    }


    if (

      isContainer(node) &&

      type !==
        "INSTANCE" &&

      getPD(
        node,
        PD_SKIP_SCREENSHOT
      ) !== "1" &&

      (
        containsMask(node) ||

        actuallyClipsChildren(
          node
        )
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
    0
  );


  const deepFirst =
    (
      a,
      b
    ) =>
      b.depth -
      a.depth;


  plan.instances.sort(
    deepFirst
  );


  plan.screenshots.sort(
    deepFirst
  );


  plan.fastFlatten.sort(
    deepFirst
  );


  plan.riskyFlatten.sort(
    deepFirst
  );


  return plan;
}


/* =========================================================
   INSTANCE
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
      async (
        root,
        task
      ) => {

        const node =
          findByPluginData(

            root,

            PD_TASK_ID,

            task.marker
          );


        if (

          !node ||

          safeType(node) !==
            "INSTANCE"
        ) {

          return {

            root,

            changed:
              false,

            reason:
              "instance-missing"
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
      async (
        task,
        tx
      ) => {

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

          tx.reason ===
            "visual-changed"

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

    !(
      "children" in parent
    )
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


  const index =
    parent.children.indexOf(
      container
    );


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

    changed:
      true,

    reason:
      "screenshot-created"
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
      async (
        root,
        task
      ) => {

        const node =
          findByPluginData(

            root,

            PD_TASK_ID,

            task.marker
          );


        if (
          !node
        ) {

          return {

            root,

            changed:
              false,

            reason:
              "container-missing"
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
      async (
        task,
        tx
      ) => {

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
   GEOMETRY
========================================================= */

function captureDirectChildGeometry(node) {

  const result =
    [];


  for (
    const child of
    childrenOf(node)
  ) {

    const box =
      safeBounds(child);


    if (
      !box
    ) {

      continue;
    }


    result.push({

      node:
        child,

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


function geometryMatches(snapshot) {

  for (
    const before of snapshot
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


    if (
      !after
    ) {

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

    !(
      "children" in parent
    )
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
    children.length ===
      0
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


  if (
    !transform
  ) {

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

    safeRemove(
      rectangle
    );


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

    safeRemove(
      rectangle
    );


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

    !(
      "children" in parent
    )
  ) {

    return {

      root,

      changed:
        false,

      reason:
        "invalid-parent"
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

      changed:
        false,

      reason:
        "index-invalid"
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

      moved:
        0,

      removed:
        1,

      shells:
        0
    };
  }


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

      changed:
        false,

      reason:
        "transform-unavailable"
    };
  }


  let insertion =
    index;


  let shells =
    0;


  if (
    hasOwnVisual(
      container
    )
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
   FLATTEN PLAN
========================================================= */

async function processFlattenPlan(
  state,
  plan,
  stats
) {

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

      failedFast.push(
        task
      );
    }
  }


  const risky = [

    ...failedFast,

    ...plan.riskyFlatten
  ];


  risky.sort(
    (
      a,
      b
    ) =>
      b.depth -
      a.depth
  );


  await processBatchWithIsolation({

    state,

    tasks:
      risky,

    stats,


    applyTask:
      async (
        root,
        task
      ) => {

        const node =
          findByPluginData(

            root,

            PD_TASK_ID,

            task.marker
          );


        if (
          !node
        ) {

          return {

            root,

            changed:
              false,

            reason:
              "container-missing"
          };
        }


        return await flattenContainerOneLevel(

          root,

          node
        );
      },


    onAccepted:
      async (
        task,
        result
      ) => {

        stats.flattenedContainers++;


        stats.removedContainers +=
          result.removed ||
          0;


        stats.movedLayers +=
          result.moved ||
          0;


        stats.visualShells +=
          result.shells ||
          0;


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


        try {

          root.name =
            originalRootName;

        } catch (_) {}
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

    try {

      root.name =
        originalRootName;

    } catch (_) {}


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


  const index =
    parent.children.indexOf(
      root
    );


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


  if (
    !transform
  ) {

    return {

      root,

      changed:
        false,

      reason:
        "transform-unavailable"
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

      changed:
        false,

      reason:
        "child-transform-unavailable"
    };
  }


  const frame =
    figma.createFrame();


  frame.name =
    originalRootName;


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


  if (
    tx.accepted
  ) {

    stats.rootConverted++;


    addReport(

      stats,

      "Root → Frame",

      "SUCCESS",

      state.root,

      "대표 Screen Name 유지"
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

      tx.reason
    );
  }
}


/* =========================================================
   FONT → INTER

   ★ 중요

   Font 변경은 사용자가 체크박스로 직접 요청한 작업이다.

   Inter로 변경하면 Glyph 자체가 달라지므로
   PNG 결과 역시 달라지는 것이 정상이다.

   따라서 Font → Inter만
   Visual Rollback 대상에서 제외한다.

   Garbage / Detach / Flatten / Screenshot / Order는
   기존 Visual Preservation을 그대로 유지한다.
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

    value.includes(
      "italic"
    ) ||

    value.includes(
      "oblique"
    );


  let style =
    "Regular";


  if (

    value.includes(
      "black"
    ) ||

    value.includes(
      "heavy"
    )
  ) {

    style =
      "Black";

  } else if (

    value.includes(
      "extra bold"
    ) ||

    value.includes(
      "extrabold"
    ) ||

    value.includes(
      "ultra bold"
    ) ||

    value.includes(
      "ultrabold"
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
    ) ||

    value.includes(
      "demi bold"
    ) ||

    value.includes(
      "demibold"
    )
  ) {

    style =
      "Semi Bold";

  } else if (
    value.includes(
      "bold"
    )
  ) {

    style =
      "Bold";

  } else if (
    value.includes(
      "medium"
    )
  ) {

    style =
      "Medium";

  } else if (

    value.includes(
      "extra light"
    ) ||

    value.includes(
      "extralight"
    ) ||

    value.includes(
      "ultra light"
    ) ||

    value.includes(
      "ultralight"
    )
  ) {

    style =
      "Extra Light";

  } else if (
    value.includes(
      "light"
    )
  ) {

    style =
      "Light";

  } else if (
    value.includes(
      "thin"
    )
  ) {

    style =
      "Thin";
  }


  if (italic) {

    return (

      style ===
        "Regular"

        ? "Italic"

        : `${style} Italic`
    );
  }


  return style;
}


/* =========================================================
   LOAD INTER STYLE
========================================================= */

async function loadInterStyle(style) {

  const wanted =
    style ||
    "Regular";


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


  /*
   * 특정 Weight를 지원하지 않으면
   * Regular fallback
   */

  if (
    !loadedInterStyles.has(
      "Regular"
    )
  ) {

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

    } catch (_) {

      return null;
    }
  }


  return "Regular";
}


function isInterFontName(fontName) {

  return !!(

    fontName &&

    fontName !==
      figma.mixed &&

    fontName.family ===
      "Inter"
  );
}


/* =========================================================
   FINAL TEXT SCAN

   구조 변경이 끝난 뒤 실제 남은 Text 전체를 다시 찾는다.

   기존 Execution Plan의 Text 목록을 쓰지 않는다.
========================================================= */

function buildInterTextTasks(
  root,
  stats
) {

  const tasks =
    [];


  stats.treeScans++;


  function walk(node) {

    if (
      !isAlive(node)
    ) {

      return;
    }


    if (
      safeType(node) ===
        "TEXT"
    ) {

      const marker =
        createTaskMarker(
          "inter"
        );


      setPD(
        node,
        PD_TASK_ID,
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
   SET SEGMENT → INTER
========================================================= */

async function setRangeToInter(
  node,
  segment,
  targetStyle
) {

  const targetFont = {

    family:
      "Inter",

    style:
      targetStyle
  };


  /*
   * 1차 시도
   */

  try {

    node.setRangeFontName(

      segment.start,

      segment.end,

      targetFont
    );


    return true;

  } catch (_) {}


  /*
   * 일부 문서는 기존 Font Load가 필요할 수 있음.
   */

  try {

    if (

      segment.fontName &&

      segment.fontName !==
        figma.mixed
    ) {

      await loadFontOnce(
        segment.fontName
      );
    }


    node.setRangeFontName(

      segment.start,

      segment.end,

      targetFont
    );


    return true;

  } catch (_) {

    return false;
  }
}


/* =========================================================
   TEXT NODE → INTER
========================================================= */

async function convertTextNodeToInter(node) {

  if (

    !isAlive(node) ||

    safeType(node) !==
      "TEXT"
  ) {

    return {

      changed:
        false,

      convertedSegments:
        0,

      failedSegments:
        0,

      alreadyInter:
        false,

      reason:
        "not-text"
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

      changed:
        false,

      convertedSegments:
        0,

      failedSegments:
        1,

      alreadyInter:
        false,

      reason:
        "segment-read-failed"
    };
  }


  /*
   * 빈 Text Layer
   */

  if (
    segments.length ===
      0
  ) {

    const regular =
      await loadInterStyle(
        "Regular"
      );


    if (
      !regular
    ) {

      return {

        changed:
          false,

        convertedSegments:
          0,

        failedSegments:
          1,

        alreadyInter:
          false,

        reason:
          "inter-unavailable"
      };
    }


    try {

      if (
        isInterFontName(
          node.fontName
        )
      ) {

        return {

          changed:
            false,

          convertedSegments:
            0,

          failedSegments:
            0,

          alreadyInter:
            true,

          reason:
            "already-inter"
        };
      }


      node.fontName = {

        family:
          "Inter",

        style:
          regular
      };


      return {

        changed:
          true,

        convertedSegments:
          1,

        failedSegments:
          0,

        alreadyInter:
          false,

        reason:
          "font-converted"
      };

    } catch (_) {

      return {

        changed:
          false,

        convertedSegments:
          0,

        failedSegments:
          1,

        alreadyInter:
          false,

        reason:
          "empty-text-font-set-failed"
      };
    }
  }


  let convertedSegments =
    0;


  let failedSegments =
    0;


  let nonInterSegments =
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


    nonInterSegments++;


    const sourceStyle =

      segment.fontName &&

      segment.fontName !==
        figma.mixed

        ? segment.fontName.style

        : "Regular";


    const mappedStyle =
      mapInterStyle(
        sourceStyle
      );


    const targetStyle =
      await loadInterStyle(
        mappedStyle
      );


    if (
      !targetStyle
    ) {

      failedSegments++;


      continue;
    }


    const success =
      await setRangeToInter(

        node,

        segment,

        targetStyle
      );


    if (success) {

      convertedSegments++;

    } else {

      failedSegments++;
    }
  }


  if (
    nonInterSegments ===
      0
  ) {

    return {

      changed:
        false,

      convertedSegments:
        0,

      failedSegments:
        0,

      alreadyInter:
        true,

      reason:
        "already-inter"
    };
  }


  return {

    changed:
      convertedSegments >
      0,

    convertedSegments,

    failedSegments,

    alreadyInter:
      false,

    reason:

      failedSegments ===
        0

        ? "font-converted"

        : convertedSegments >
            0

          ? "partially-converted"

          : "font-conversion-failed"
  };
}


/* =========================================================
   PROCESS FONT → INTER

   ★ Visual Transaction을 사용하지 않는다.
========================================================= */

async function processTextTasks(
  state,
  tasks,
  stats
) {

  if (
    !convertFontToInter
  ) {

    return;
  }


  for (
    const task of tasks
  ) {

    const text =
      findByPluginData(

        state.root,

        PD_TASK_ID,

        task.marker
      );


    if (

      !text ||

      safeType(text) !==
        "TEXT"
    ) {

      stats.failedFontConversions++;


      addReport(

        stats,

        "Font → Inter",

        "REJECTED",

        text,

        `"${task.name}" · Text Layer를 찾을 수 없음`
      );


      continue;
    }


    const conversion =
      await convertTextNodeToInter(
        text
      );


    setPD(
      text,
      PD_INTER_DONE,
      "1"
    );


    if (
      conversion.changed
    ) {

      stats.convertedTexts++;


      stats.convertedFontSegments +=
        conversion.convertedSegments ||
        0;


      if (
        conversion.failedSegments >
        0
      ) {

        stats.failedFontConversions++;


        addReport(

          stats,

          "Font → Inter",

          "REJECTED",

          text,

          `${conversion.convertedSegments} segment converted / ${conversion.failedSegments} segment failed`
        );

      } else {

        addReport(

          stats,

          "Font → Inter",

          "SUCCESS",

          text,

          `${conversion.convertedSegments} segment(s) → Inter`
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

      conversion.reason ||
      "Font conversion failed"
    );
  }
}


/* =========================================================
   NAMING
========================================================= */

function looksLikeScreenshotName(name) {

  const value =
    String(
      name ||
      ""
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
      name ||
      ""
    )
      .toLowerCase();


  return (

    value ===
      "icon" ||

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
    type ===
      "LINE"
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

      root.width >
        0 &&

      root.height >
        0 &&

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

    value.includes(
      "iphone"
    ) ||

    value.includes(
      "i phone"
    )
  );
}


/* =========================================================
   CONTAINER NAMING
========================================================= */

function getContainerLayerName(node) {

  const type =
    safeType(node);


  if (

    type ===
      "FRAME" &&

    isAutoLayout(node)
  ) {

    return (
      "auto layout"
    );
  }


  if (

    type ===
      "FRAME" &&

    looksLikeIPhone(node)
  ) {

    return (
      "iphone"
    );
  }


  if (
    type ===
      "FRAME"
  ) {

    return (
      "frame"
    );
  }


  if (
    type ===
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


  /*
   * 대표 Screen 이름은 항상 유지
   */

  if (
    node === root
  ) {

    return current;
  }


  /*
   * LID 이름 보호
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
    type ===
      "TEXT"
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

    type ===
      "RECTANGLE" &&

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


  /*
   * Frame / Group / Auto Layout
   * 선택 옵션
   */

  if (

    type ===
      "FRAME" ||

    type ===
      "GROUP"
  ) {

    return (

      renameContainers

        ? (
            getContainerLayerName(
              node
            ) ||
            current
          )

        : current
    );
  }


  if (
    type ===
      "COMPONENT"
  ) {

    return (
      "component"
    );
  }


  if (
    type ===
      "INSTANCE"
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

    if (
      !isAlive(node)
    ) {

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

            "Name 변경 실패"
          );
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


  if (
    !box
  ) {

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
      a.y -
      b.y
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

    overlap >
      0 &&

    overlap >=

      Math.min(
        a.height,
        b.height
      ) *
      0.5
  );
}


function boundsOverlap(
  a,
  b
) {

  return !!(

    a &&

    b &&

    !(

      a.right <=
        b.x ||

      b.right <=
        a.x ||

      a.bottom <=
        b.y ||

      b.bottom <=
        a.y
    )
  );
}


function buildVisualRows(items) {

  const sorted =
    [...items]
      .sort(
        (
          a,
          b
        ) => {

          if (

            !a.bounds &&

            !b.bounds
          ) {

            return (
              a.originalPanelIndex -
              b.originalPanelIndex
            );
          }


          if (
            !a.bounds
          ) {

            return 1;
          }


          if (
            !b.bounds
          ) {

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


  const rows =
    [];


  for (
    const item of sorted
  ) {

    if (
      !item.bounds
    ) {

      rows.push({

        y:
          Infinity,

        items:
          [item]
      });


      continue;
    }


    let row =
      rows.find(
        candidate =>

          candidate.items.some(
            current =>

              current.bounds &&

              isSameVisualRow(
                current.bounds,
                item.bounds
              )
          )
      );


    if (
      !row
    ) {

      row = {

        y:
          item.bounds.y,

        items:
          []
      };


      rows.push(
        row
      );
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


  rows.sort(
    (
      a,
      b
    ) =>
      a.y -
      b.y
  );


  for (
    const row of rows
  ) {

    row.items.sort(
      (
        a,
        b
      ) => {

        if (

          !a.bounds &&

          !b.bounds
        ) {

          return (
            a.originalPanelIndex -
            b.originalPanelIndex
          );
        }


        if (
          !a.bounds
        ) {

          return 1;
        }


        if (
          !b.bounds
        ) {

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


  const currentPanel =
    [...children]
      .reverse();


  const items =
    currentPanel.map(
      (
        node,
        index
      ) => ({

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
    (
      item,
      index
    ) => {

      item.desiredRank =
        index;
    }
  );


  /*
   * 겹치는 레이어는 기존 Z-order 보존
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
        item.indegree ===
        0
    );


  const output =
    [];


  while (
    available.length
  ) {

    available.sort(
      (
        a,
        b
      ) => (

        (
          a.desiredRank -
          b.desiredRank
        ) ||

        (
          a.originalPanelIndex -
          b.originalPanelIndex
        )
      )
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
        next.indegree ===
        0
      ) {

        available.push(
          next
        );
      }
    }
  }


  return (

    output.length ===
      items.length

      ? output

      : null
  );
}


async function reorderRootLayers(root) {

  if (
    !isAlive(root)
  ) {

    return {

      root,

      changed:
        false,

      reason:
        "root-missing"
    };
  }


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
    children.length <=
    1
  ) {

    return {

      root,

      changed:
        false,

      reason:
        "single-layer"
    };
  }


  const panel =
    buildSafeDesiredPanelOrder(
      root
    );


  if (
    !panel
  ) {

    return {

      root,

      changed:
        false,

      reason:
        "z-order-cycle"
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
      (
        node,
        index
      ) =>

        node !==
        desiredChildren[index]
    );


  if (
    !changed
  ) {

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

      tx.reason ===
        "visual-changed"

        ? "Z-order 변경 감지 · 기존 순서 유지"

        : tx.reason
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

    if (
      !isAlive(node)
    ) {

      return;
    }


    if (

      isContainer(node) &&

      node !== root
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


  /*
   * 대표 Screen 이름 보존
   */

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


  if (
    !isAlive(originalRoot)
  ) {

    return {

      success:
        false,

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
        "Screen must be a direct Page child."
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

      success:
        false,

      root:
        originalRoot,

      stats,

      fatalReason:
        error.message ||
        String(error)
    };
  }


  try {

    state.root.name =
      originalScreenName;

  } catch (_) {}


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
     2. ROOT FRAME
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
     3. INSTANCE
  ===================================================== */

  let plan =
    buildExecutionPlan(
      state.root,
      stats
    );


  for (
    let round = 0;
    round <
      MAX_INSTANCE_ROUNDS;
    round++
  ) {

    if (
      plan.instances.length ===
        0
    ) {

      break;
    }


    await processInstanceTasks(

      state,

      plan.instances,

      stats
    );


    if (
      round <
      MAX_INSTANCE_ROUNDS -
        1
    ) {

      plan =
        buildExecutionPlan(

          state.root,

          stats
        );
    }
  }


  /* =====================================================
     4. STRUCTURE PLAN
  ===================================================== */

  plan =
    buildExecutionPlan(
      state.root,
      stats
    );


  /* =====================================================
     5. MASK / CLIP
  ===================================================== */

  await processScreenshotTasks(

    state,

    plan.screenshots,

    stats
  );


  /* =====================================================
     6. FLATTEN
  ===================================================== */

  await processFlattenPlan(

    state,

    plan,

    stats
  );


  /* =====================================================
     7. FONT → INTER

     ★ 구조 작업 이후 실제 Text 전체를 다시 Scan
  ===================================================== */

  if (
    convertFontToInter
  ) {

    const interTasks =
      buildInterTextTasks(

        state.root,

        stats
      );


    await processTextTasks(

      state,

      interTasks,

      stats
    );
  }


  /* =====================================================
     8. NAMING
  ===================================================== */

  processNaming(
    state.root,
    stats
  );


  try {

    state.root.name =
      originalScreenName;

  } catch (_) {}


  addReport(

    stats,

    "Layer Naming",

    "SUCCESS",

    state.root,

    `${stats.renamedLayers} layers renamed · Root name preserved`
  );


  /* =====================================================
     9. ORDER
  ===================================================== */

  await processOrder(
    state,
    stats
  );


  try {

    state.root.name =
      originalScreenName;

  } catch (_) {}


  /* =====================================================
     10. CLEAN INTERNAL DATA
  ===================================================== */

  clearInternalPluginData(
    state.root
  );


  /* =====================================================
     11. COMMIT
  ===================================================== */

  const committed =
    commitWorkingRoot(

      originalRoot,

      state.root
    );


  if (
    !committed
  ) {

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
   GET ANALYZED ROOTS
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

        result.push(
          node
        );
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
    msg.type ===
    "close"
  ) {

    figma.closePlugin();


    return;
  }


  /* =====================================================
     SELECT GARBAGE LAYER
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
          "PAGE" ||

        node.type ===
          "DOCUMENT"
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
     * analyzedRootIds는 변경하지 않는다.
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
      ]

        .filter(
          isAlive
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
    msg.type ===
    "clean"
  ) {

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

              isSupportedRoot(
                node
              )
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
      roots.length ===
        0
    ) {

      figma.ui.postMessage({

        type:
          "error",

        message:
          "Analyze했던 Screen을 찾을 수 없습니다. Screen을 다시 선택한 뒤 Analyze Screen을 실행해주세요."
      });


      return;
    }


    /* =====================================================
       OPTIONS
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

      type:
        "processing"
    });


    const resultRoots =
      [];


    const total = {

      screens:
        roots.length,

      committed:
        0,

      rolledBack:
        0,

      detachedInstances:
        0,

      rejectedInstances:
        0,

      removedGarbage:
        0,

      protectedGarbage:
        0,

      removedContainers:
        0,

      movedLayers:
        0,

      flattenedContainers:
        0,

      flattenRejected:
        0,

      fastGarbage:
        0,

      fastFlatten:
        0,

      screenshotBaked:
        0,

      screenshotRejected:
        0,

      rootConverted:
        0,

      rootConversionRejected:
        0,

      convertedTexts:
        0,

      convertedFontSegments:
        0,

      failedFontConversions:
        0,

      renamedLayers:
        0,

      renameSkipped:
        0,

      orderChanged:
        0,

      orderRejected:
        0,

      preservedAreas:
        0,

      visualShells:
        0,

      bakedAreas:
        0,

      finalLayers:
        0,

      treeScans:
        0,

      visualBatchChecks:
        0,

      binarySplits:
        0,

      report:
        [],

      failureReasons:
        []
    };


    /* =====================================================
       PROCESS ROOTS
    ===================================================== */

    for (
      const root of roots
    ) {

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
                safeName(root),

              reason:
                processResult.fatalReason
            });
          }
        }


        for (
          const key of
          Object.keys(
            processResult.stats
          )
        ) {

          if (
            key ===
            "report"
          ) {

            total.report.push(

              ...processResult
                .stats
                .report
            );


            continue;
          }


          if (

            key in total &&

            typeof total[key] ===
              "number"
          ) {

            total[key] +=
              processResult
                .stats[key];
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


    /* =====================================================
       FINAL SELECTION
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
       UI RESULT
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
      "Rename Containers:",
      renameContainers
    );


    console.log(
      "Text → Hyphen:",
      renameTextToHyphen
    );


    console.log(
      "Font → Inter:",
      convertFontToInter
    );


    console.log(
      "Converted Text:",
      total.convertedTexts
    );


    console.log(
      "Converted Font Segments:",
      total.convertedFontSegments
    );


    console.log(
      "Font Conversion Failed:",
      total.failedFontConversions
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
      total.failureReasons.length
    ) {

      console.error(

        "Fatal Failures:",

        total.failureReasons
      );
    }


    /* =====================================================
       NOTIFICATION
    ===================================================== */

    if (
      total.rolledBack ===
        0
    ) {

      figma.notify(

        `Cleanup 완료 · Garbage ${total.removedGarbage} · Flatten ${total.flattenedContainers} · Inter ${total.convertedTexts} · Rename ${total.renamedLayers}`
      );

    } else {

      figma.notify(

        `Cleanup 완료 · ${total.committed}개 적용 / ${total.rolledBack}개 원본 유지`
      );
    }


    return;
  }
};
