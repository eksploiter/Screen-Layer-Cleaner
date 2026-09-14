figma.showUI(__html__, {
  width: 400,
  height: 580,
  themeColors: true
});


/* =========================================================
   Screen Layer Cleaner
   =========================================================

   목표

   1. 화면에 보이지 않는 Garbage Layer 삭제
   2. Instance Detach
   3. Auto Layout / Frame / Group / Component 구조 제거
   4. 실제 표시되는 Layer를 Screen 바로 아래 1 Depth로 이동
   5. 기존 Visual 최대한 유지
   6. Clip / Mask / Composite 예외는 Image Bake
   7. Text Layer Name → "-"
   8. Icon → "icon"
   9. Line → "line"
   10. Rectangle → "shape"
   11. Image → "image"

   중요:
   선택한 최상위 Screen Frame 자체는 유지한다.
========================================================= */


/* =========================================================
   Transform Utility
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

  const det = a * d - b * c;

  if (Math.abs(det) < 0.000001) {
    throw new Error(
      "Transform matrix cannot be inverted."
    );
  }

  const invDet = 1 / det;

  return [
    [
      d * invDet,
      -c * invDet,
      (c * f - d * e) * invDet
    ],

    [
      -b * invDet,
      a * invDet,
      (b * e - a * f) * invDet
    ]
  ];
}


function absoluteToRelative(
  absoluteTransform,
  parent
) {
  const parentInverse =
    invertTransform(
      parent.absoluteTransform
    );

  return multiplyTransform(
    parentInverse,
    absoluteTransform
  );
}


/**
 * Render Bounds 같이
 * 절대 x, y만 가지고 있을 때 사용
 */
function positionToRelativeTransform(
  x,
  y,
  parent
) {
  const absoluteTransform = [
    [1, 0, x],
    [0, 1, y]
  ];

  return absoluteToRelative(
    absoluteTransform,
    parent
  );
}


/* =========================================================
   Node Type Helpers
========================================================= */

function isContainer(node) {
  return (
    node.type === "FRAME" ||
    node.type === "GROUP" ||
    node.type === "COMPONENT" ||
    node.type === "INSTANCE"
  );
}


function isIconType(node) {
  return (
    node.type === "VECTOR" ||
    node.type === "BOOLEAN_OPERATION" ||
    node.type === "STAR" ||
    node.type === "POLYGON" ||
    node.type === "ELLIPSE"
  );
}


function hasChildren(node) {
  return (
    "children" in node &&
    Array.isArray(node.children)
  );
}


/* =========================================================
   Garbage Detection
========================================================= */

/**
 * "확실하게 화면에 영향을 주지 않는 것"만 삭제한다.
 *
 * 애매한 경우에는 삭제하지 않는다.
 */
function isDefinitelyGarbage(node) {

  /*
   * Figma hidden layer
   */
  if (
    "visible" in node &&
    node.visible === false
  ) {
    return true;
  }


  /*
   * 완전 투명
   */
  if (
    "opacity" in node &&
    node.opacity === 0
  ) {
    return true;
  }


  /*
   * Slice는 화면 렌더링 자체가 목적이 아니므로 제거
   */
  if (node.type === "SLICE") {
    return true;
  }


  return false;
}


/* =========================================================
   Paint Helpers
========================================================= */

function hasVisiblePaint(paints) {
  if (
    !Array.isArray(paints)
  ) {
    return false;
  }

  return paints.some(paint => {

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
  });
}


function hasVisibleEffects(node) {
  if (
    !("effects" in node) ||
    !Array.isArray(node.effects)
  ) {
    return false;
  }

  return node.effects.some(effect => {
    return effect.visible !== false;
  });
}


/**
 * Frame / Component 자체가
 * 실제 Visual을 가지고 있는지 확인
 */
function hasOwnVisual(node) {

  if (
    "fills" in node &&
    node.fills !== figma.mixed &&
    hasVisiblePaint(node.fills)
  ) {
    return true;
  }

  if (
    "strokes" in node &&
    node.strokes !== figma.mixed &&
    hasVisiblePaint(node.strokes)
  ) {
    return true;
  }

  return false;
}


/* =========================================================
   Mask / Composite Detection
========================================================= */

function containsMask(node) {

  if (!hasChildren(node)) {
    return false;
  }

  for (const child of node.children) {

    if (
      "isMask" in child &&
      child.isMask === true
    ) {
      return true;
    }

    if (
      hasChildren(child) &&
      containsMask(child)
    ) {
      return true;
    }
  }

  return false;
}


/**
 * 구조를 없앴을 때 시각적으로 동일하다고
 * 보장하기 어려운 Container 판단
 *
 * 이런 경우 "중단"하지 않고
 * Image Bake 처리한다.
 */
function needsBake(node) {

  if (!isContainer(node)) {
    return false;
  }


  /*
   * Nested Clip
   *
   * Root Screen의 Clip은 유지하므로
   * Root는 이 함수에 넣지 않는다.
   */
  if (
    "clipsContent" in node &&
    node.clipsContent === true
  ) {
    return true;
  }


  /*
   * Mask 구조
   */
  if (containsMask(node)) {
    return true;
  }


  /*
   * Parent opacity가 1이 아닐 경우
   *
   * 자식을 바깥으로 빼면
   * alpha compositing 결과가 달라질 수 있다.
   */
  if (
    "opacity" in node &&
    node.opacity !== 1
  ) {
    return true;
  }


  /*
   * Blend Mode
   */
  if (
    "blendMode" in node &&
    node.blendMode !== "PASS_THROUGH" &&
    node.blendMode !== "NORMAL"
  ) {
    return true;
  }


  /*
   * Blur / Shadow 등의 Effect
   *
   * Container 레벨 효과는
   * 안전하게 Bake한다.
   */
  if (hasVisibleEffects(node)) {
    return true;
  }


  return false;
}


/* =========================================================
   Image Fill Detection
========================================================= */

function hasImageFill(node) {

  if (
    !("fills" in node) ||
    node.fills === figma.mixed ||
    !Array.isArray(node.fills)
  ) {
    return false;
  }

  return node.fills.some(fill => {
    return (
      fill.type === "IMAGE" &&
      fill.visible !== false
    );
  });
}


/* =========================================================
   Rename
========================================================= */

function normalizeLayerName(node) {

  /*
   * 실제 화면 Text는 수정하지 않는다.
   *
   * characters 절대 변경 X
   */
  if (node.type === "TEXT") {
    node.name = "-";
    return;
  }


  if (node.type === "LINE") {
    node.name = "line";
    return;
  }


  if (isIconType(node)) {
    node.name = "icon";
    return;
  }


  if (node.type === "RECTANGLE") {

    if (hasImageFill(node)) {
      node.name = "image";
    } else {
      node.name = "shape";
    }

    return;
  }


  if (node.type === "IMAGE") {
    node.name = "image";
    return;
  }
}


/* =========================================================
   Instance Detach
========================================================= */

function detachInstancesRecursive(parent, stats) {

  if (!hasChildren(parent)) {
    return;
  }

  const children =
    [...parent.children];


  for (const child of children) {

    let target = child;


    if (
      child.type === "INSTANCE"
    ) {

      try {

        target =
          child.detachInstance();

        stats.detachedInstances++;

      } catch (error) {

        console.warn(
          "Instance detach failed:",
          child.name,
          error
        );

        /*
         * Detach 실패 시
         * 해당 Instance는 나중에 Bake 대상으로 사용
         */
        continue;
      }
    }


    if (hasChildren(target)) {
      detachInstancesRecursive(
        target,
        stats
      );
    }
  }
}


/* =========================================================
   Visual Shell Snapshot
========================================================= */

/**
 * Frame 자체의 Fill / Stroke 등
 * Visual 정보를 저장한다.
 *
 * Frame을 제거하더라도
 * Rectangle로 재현할 수 있도록 한다.
 */
function snapshotContainerVisual(node) {

  const data = {
    width: node.width,
    height: node.height,

    absoluteTransform:
      node.absoluteTransform,

    fills: null,
    strokes: null,
    strokeWeight: null,
    strokeAlign: null,

    topLeftRadius: 0,
    topRightRadius: 0,
    bottomLeftRadius: 0,
    bottomRightRadius: 0
  };


  if (
    "fills" in node &&
    node.fills !== figma.mixed
  ) {
    data.fills =
      node.fills;
  }


  if (
    "strokes" in node &&
    node.strokes !== figma.mixed
  ) {
    data.strokes =
      node.strokes;
  }


  if (
    "strokeWeight" in node
  ) {
    data.strokeWeight =
      node.strokeWeight;
  }


  if (
    "strokeAlign" in node
  ) {
    data.strokeAlign =
      node.strokeAlign;
  }


  try {

    if (
      "topLeftRadius" in node
    ) {
      data.topLeftRadius =
        node.topLeftRadius;
    }

    if (
      "topRightRadius" in node
    ) {
      data.topRightRadius =
        node.topRightRadius;
    }

    if (
      "bottomLeftRadius" in node
    ) {
      data.bottomLeftRadius =
        node.bottomLeftRadius;
    }

    if (
      "bottomRightRadius" in node
    ) {
      data.bottomRightRadius =
        node.bottomRightRadius;
    }

  } catch (_) {}


  return data;
}


/* =========================================================
   Create Visual Shell
========================================================= */

function createVisualShell(
  snapshot,
  root
) {

  const rect =
    figma.createRectangle();


  rect.resize(
    Math.max(
      snapshot.width,
      0.01
    ),

    Math.max(
      snapshot.height,
      0.01
    )
  );


  rect.name = "shape";


  if (snapshot.fills !== null) {

    try {
      rect.fills =
        snapshot.fills;
    } catch (_) {}
  }


  if (snapshot.strokes !== null) {

    try {
      rect.strokes =
        snapshot.strokes;
    } catch (_) {}
  }


  if (
    snapshot.strokeWeight !== null
  ) {

    try {
      rect.strokeWeight =
        snapshot.strokeWeight;
    } catch (_) {}
  }


  if (
    snapshot.strokeAlign !== null
  ) {

    try {
      rect.strokeAlign =
        snapshot.strokeAlign;
    } catch (_) {}
  }


  try {

    rect.topLeftRadius =
      snapshot.topLeftRadius;

    rect.topRightRadius =
      snapshot.topRightRadius;

    rect.bottomLeftRadius =
      snapshot.bottomLeftRadius;

    rect.bottomRightRadius =
      snapshot.bottomRightRadius;

  } catch (_) {}


  root.appendChild(rect);


  try {

    rect.relativeTransform =
      absoluteToRelative(
        snapshot.absoluteTransform,
        root
      );

  } catch (error) {

    console.warn(
      "Visual shell transform failed",
      error
    );
  }


  return rect;
}


/* =========================================================
   Bake
========================================================= */

/**
 * Mask / Clip / Composite 영역을
 * PNG 이미지 하나로 굽는다.
 *
 * 실제 화면 결과를 우선 보존하기 위한
 * fallback 방식이다.
 */
async function createBakeSnapshot(node) {

  const bounds =
    node.absoluteRenderBounds ||
    node.absoluteBoundingBox;


  if (
    !bounds ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    return null;
  }


  try {

    const bytes =
      await node.exportAsync({
        format: "PNG",
        constraint: {
          type: "SCALE",
          value: 2
        }
      });


    return {
      bytes,

      x: bounds.x,
      y: bounds.y,

      width: bounds.width,
      height: bounds.height,

      sourceName: node.name
    };


  } catch (error) {

    console.warn(
      "Bake export failed:",
      node.name,
      error
    );

    return null;
  }
}


/**
 * 저장해둔 PNG를
 * Rectangle Image Fill로 만든다.
 */
function createBakedImage(
  snapshot,
  root
) {

  if (!snapshot) {
    return null;
  }


  try {

    const image =
      figma.createImage(
        snapshot.bytes
      );


    const rect =
      figma.createRectangle();


    rect.name = "image";


    rect.resize(
      Math.max(
        snapshot.width,
        0.01
      ),

      Math.max(
        snapshot.height,
        0.01
      )
    );


    rect.fills = [
      {
        type: "IMAGE",
        scaleMode: "FILL",
        imageHash: image.hash
      }
    ];


    root.appendChild(rect);


    rect.relativeTransform =
      positionToRelativeTransform(
        snapshot.x,
        snapshot.y,
        root
      );


    return rect;


  } catch (error) {

    console.warn(
      "Failed to create baked image:",
      error
    );

    return null;
  }
}


/* =========================================================
   Plan Builder
========================================================= */

/**
 * 바로 Node를 옮기지 않는다.
 *
 * 먼저 모든 구조를 분석해서
 * 최종 1 Depth 결과를 Plan으로 만든다.
 *
 * 이유:
 * Mask 등을 export하기 전에
 * 다른 Layer를 먼저 부모 밖으로 옮겨버리면
 * 원본 Visual이 바뀔 수 있기 때문이다.
 */
async function buildFlattenPlan(
  root,
  stats
) {

  const plan = [];


  async function visit(node) {

    /*
     * Garbage
     */
    if (isDefinitelyGarbage(node)) {

      plan.push({
        type: "garbage",
        node
      });

      return;
    }


    /*
     * Container
     */
    if (isContainer(node)) {


      /*
       * Clip / Mask / Effect 등
       * 위험한 Composite
       */
      if (needsBake(node)) {

        const baked =
          await createBakeSnapshot(
            node
          );


        if (baked) {

          plan.push({
            type: "bake",
            source: node,
            snapshot: baked
          });

          stats.bakedAreas++;

          return;
        }


        /*
         * Bake 자체가 실패하면
         * 강제로 뜯지 않고
         * 해당 구조를 보존한다.
         */
        plan.push({
          type: "preserve",
          node
        });

        stats.preservedAreas++;

        return;
      }


      /*
       * Frame 자체 Background
       */
      if (hasOwnVisual(node)) {

        plan.push({
          type: "shell",
          source: node,
          snapshot:
            snapshotContainerVisual(
              node
            )
        });
      }


      /*
       * Child 순서대로 분석
       */
      if (hasChildren(node)) {

        const children =
          [...node.children];

        for (const child of children) {

          await visit(child);

        }
      }


      return;
    }


    /*
     * Mask Layer 단독
     *
     * Parent가 제대로 Bake되지 않은
     * 예외에 대비
     */
    if (
      "isMask" in node &&
      node.isMask === true
    ) {

      plan.push({
        type: "garbage",
        node
      });

      return;
    }


    /*
     * 일반 Leaf
     */
    plan.push({
      type: "leaf",

      node,

      absoluteTransform:
        node.absoluteTransform
    });
  }


  const topChildren =
    [...root.children];


  for (
    const child of topChildren
  ) {

    await visit(child);

  }


  return plan;
}


/* =========================================================
   Execute Plan
========================================================= */

function executeFlattenPlan(
  root,
  plan,
  stats
) {

  /*
   * 원래 Root의 Child 기억
   *
   * 최종적으로 Container 정리 시 사용
   */
  const originalChildren =
    [...root.children];


  /*
   * Garbage 먼저 삭제하면
   * 위험 Container export 결과가 영향을 받을 수 있는데,
   * 이미 Plan 단계에서 export가 모두 끝났으므로
   * 이제 삭제해도 된다.
   */
  for (const item of plan) {

    if (
      item.type !== "garbage"
    ) {
      continue;
    }


    try {

      if (
        item.node &&
        !item.node.removed
      ) {

        item.node.remove();

        stats.removedGarbage++;
      }

    } catch (error) {

      console.warn(
        "Garbage delete failed",
        error
      );
    }
  }


  /*
   * Plan 순서대로 Root에 추가한다.
   *
   * Plan 순서 =
   * 원래 Layer Paint 순서
   *
   * 따라서 Z-order도 최대한 보존된다.
   */
  for (const item of plan) {


    /* ---------------------------------
       Garbage
    --------------------------------- */

    if (
      item.type === "garbage"
    ) {
      continue;
    }


    /* ---------------------------------
       Visual Shell
    --------------------------------- */

    if (
      item.type === "shell"
    ) {

      const shell =
        createVisualShell(
          item.snapshot,
          root
        );


      if (shell) {

        stats.visualShells++;
        stats.finalLayers++;

      }

      continue;
    }


    /* ---------------------------------
       Bake
    --------------------------------- */

    if (
      item.type === "bake"
    ) {

      const image =
        createBakedImage(
          item.snapshot,
          root
        );


      if (image) {

        stats.finalLayers++;

      }

      continue;
    }


    /* ---------------------------------
       Preserve
    --------------------------------- */

    if (
      item.type === "preserve"
    ) {

      /*
       * 극히 드문 경우
       *
       * Export까지 실패했다면
       * 화면 보존을 위해 Container 자체를
       * Root 아래에 둔다.
       *
       * 따라서 이 경우만
       * 완전한 1 Depth가 아닐 수 있다.
       */
      try {

        const abs =
          item.node.absoluteTransform;


        root.appendChild(
          item.node
        );


        item.node.relativeTransform =
          absoluteToRelative(
            abs,
            root
          );


        stats.finalLayers++;

      } catch (error) {

        console.warn(
          "Preserve failed",
          error
        );
      }


      continue;
    }


    /* ---------------------------------
       Normal Leaf
    --------------------------------- */

    if (
      item.type === "leaf"
    ) {

      const node =
        item.node;


      if (
        !node ||
        node.removed
      ) {
        continue;
      }


      try {

        /*
         * 기존 위치 저장
         * → Root Child로 이동
         * → Absolute 위치 복원
         */
        root.appendChild(node);


        node.relativeTransform =
          absoluteToRelative(
            item.absoluteTransform,
            root
          );


        /*
         * Auto Layout 관련 속성의 영향을
         * 더 이상 받지 않는다.
         */
        try {

          if (
            "layoutPositioning" in node
          ) {
            node.layoutPositioning =
              "AUTO";
          }

        } catch (_) {}


        normalizeLayerName(
          node
        );


        stats.movedLayers++;
        stats.finalLayers++;


      } catch (error) {

        console.warn(
          "Leaf move failed:",
          node.name,
          error
        );
      }
    }
  }


  /*
   * 최종 결과에 사용되지 않는
   * 기존 Container 제거
   */
  for (
    const child of originalChildren
  ) {

    if (
      !child ||
      child.removed
    ) {
      continue;
    }


    /*
     * 이미 Root 아래의 Leaf로 이동된 경우
     * 제거하면 안 된다.
     */
    const isResultLeaf =
      plan.some(item => {
        return (
          item.type === "leaf" &&
          item.node === child
        );
      });


    const isPreserved =
      plan.some(item => {
        return (
          item.type === "preserve" &&
          item.node === child
        );
      });


    if (
      isResultLeaf ||
      isPreserved
    ) {
      continue;
    }


    if (
      isContainer(child)
    ) {

      try {

        child.remove();

        stats.removedContainers++;

      } catch (_) {}
    }
  }
}


/* =========================================================
   Root Cleanup
========================================================= */

function prepareRoot(root) {

  /*
   * Screen 자체는 남긴다.
   *
   * Auto Layout Screen이라면
   * 현재 Visual을 그대로 유지한 상태에서
   * Layout Mode만 제거
   */
  if (
    "layoutMode" in root &&
    root.layoutMode !== "NONE"
  ) {

    try {
      root.layoutMode = "NONE";
    } catch (_) {}
  }


  /*
   * Root clip은 유지한다.
   *
   * 화면 밖 Content가 갑자기 나타나면 안 되므로
   * clipsContent 값은 변경하지 않는다.
   */
}


/* =========================================================
   Analyze
========================================================= */

function analyzeScreen(root) {

  const result = {
    total: 0,

    garbage: 0,
    containers: 0,

    instances: 0,
    autoLayouts: 0,

    masks: 0,
    clips: 0,

    text: 0,
    icons: 0,
    lines: 0,

    bakeCandidates: 0
  };


  function walk(node) {

    result.total++;


    if (
      isDefinitelyGarbage(node)
    ) {
      result.garbage++;
    }


    if (
      node !== root &&
      isContainer(node)
    ) {

      result.containers++;

      if (
        needsBake(node)
      ) {
        result.bakeCandidates++;
      }
    }


    if (
      node.type === "INSTANCE"
    ) {
      result.instances++;
    }


    if (
      "layoutMode" in node &&
      node.layoutMode !== "NONE"
    ) {
      result.autoLayouts++;
    }


    if (
      "isMask" in node &&
      node.isMask === true
    ) {
      result.masks++;
    }


    if (
      node !== root &&
      "clipsContent" in node &&
      node.clipsContent === true
    ) {
      result.clips++;
    }


    if (
      node.type === "TEXT"
    ) {
      result.text++;
    }


    if (
      isIconType(node)
    ) {
      result.icons++;
    }


    if (
      node.type === "LINE"
    ) {
      result.lines++;
    }


    if (hasChildren(node)) {

      for (
        const child of node.children
      ) {

        walk(child);

      }
    }
  }


  walk(root);


  return result;
}


/* =========================================================
   Main Clean
========================================================= */

async function cleanScreen(root) {

  const stats = {

    detachedInstances: 0,

    removedGarbage: 0,

    removedContainers: 0,

    movedLayers: 0,

    visualShells: 0,

    bakedAreas: 0,

    preservedAreas: 0,

    finalLayers: 0
  };


  /*
   * 1.
   * Instance를 먼저 Detach
   *
   * Instance 내부 Child는 직접 이동이
   * 제한될 수 있기 때문
   */
  detachInstancesRecursive(
    root,
    stats
  );


  /*
   * 2.
   * 현재 Visual 기준 Plan 생성
   *
   * Bake가 필요한 영역은
   * 이 단계에서 PNG 추출
   */
  const plan =
    await buildFlattenPlan(
      root,
      stats
    );


  /*
   * 3.
   * Root Auto Layout 제거
   */
  prepareRoot(root);


  /*
   * 4.
   * 실제 구조 변경
   */
  executeFlattenPlan(
    root,
    plan,
    stats
  );


  return stats;
}


/* =========================================================
   Message Handler
========================================================= */

figma.ui.onmessage =
async (msg) => {


  if (
    msg.type === "close"
  ) {

    figma.closePlugin();

    return;
  }


  const selection =
    figma.currentPage.selection;


  if (
    selection.length === 0
  ) {

    figma.ui.postMessage({
      type: "error",

      message:
        "정리할 Screen Frame을 선택해주세요."
    });

    return;
  }


  /*
   * 최상위 Screen 단위 작업 권장
   */
  const roots =
    selection.filter(node => {
      return (
        node.type === "FRAME" ||
        node.type === "COMPONENT"
      );
    });


  if (
    roots.length !==
    selection.length
  ) {

    figma.ui.postMessage({
      type: "error",

      message:
        "Screen Frame 또는 Component만 선택해주세요."
    });

    return;
  }


  /* =====================================================
     ANALYZE
  ===================================================== */

  if (
    msg.type === "analyze"
  ) {

    const results =
      roots.map(root => {

        return {
          name: root.name,

          ...analyzeScreen(
            root
          )
        };
      });


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

    figma.ui.postMessage({
      type: "processing"
    });


    const total = {

      screens:
        roots.length,

      detachedInstances: 0,

      removedGarbage: 0,

      removedContainers: 0,

      movedLayers: 0,

      visualShells: 0,

      bakedAreas: 0,

      preservedAreas: 0,

      finalLayers: 0
    };


    try {

      for (
        const root of roots
      ) {

        const result =
          await cleanScreen(
            root
          );


        total.detachedInstances +=
          result.detachedInstances;

        total.removedGarbage +=
          result.removedGarbage;

        total.removedContainers +=
          result.removedContainers;

        total.movedLayers +=
          result.movedLayers;

        total.visualShells +=
          result.visualShells;

        total.bakedAreas +=
          result.bakedAreas;

        total.preservedAreas +=
          result.preservedAreas;

        total.finalLayers +=
          result.finalLayers;
      }


      /*
       * Screen을 다시 선택
       */
      figma.currentPage.selection =
        roots;


      figma.viewport
        .scrollAndZoomIntoView(
          roots
        );


      figma.ui.postMessage({
        type: "complete",
        result: total
      });


      figma.notify(
        `Cleanup 완료 · ${total.finalLayers}개 최종 Layer`
      );


    } catch (error) {

      console.error(
        error
      );


      figma.ui.postMessage({
        type: "error",

        message:
          "Cleanup 중 오류가 발생했습니다.\n\n" +
          (
            error &&
            error.message
              ? error.message
              : String(error)
          )
      });
    }
  }
};
