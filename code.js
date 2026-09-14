figma.showUI(__html__, {
  width: 430,
  height: 720,
  themeColors: true
});


/* =========================================================
   Screen Layer Cleaner

   FINAL RULE

   Root
   - FRAME     → 유지
   - INSTANCE  → Detach / Frame 정규화
   - COMPONENT → Frame 교체
   - GROUP     → Frame 교체

   Children
   - 최대한 모두 Root 바로 아래 1 Depth
   - Instance → Detach
   - Frame / Group / Auto Layout → 제거
   - Clip / Mask / Composite → screenshot Bake

   Naming
   - TEXT      → "-" (옵션)
   - VECTOR    → icon
   - LINE      → line
   - RECTANGLE → shape
   - IMAGE     → image
   - Bake      → screenshot

   Font
   - 모든 일반 Text → Inter

   Garbage
   - Analyze
   - 상세 확인
   - 승인한 Layer만 삭제

   Layer Order
   - Top → Bottom
   - 같은 Row → Left → Right
========================================================= */


/* =========================================================
   Global State
========================================================= */

let approvedGarbageIds = new Set();

let renameTextToHyphen = false;


/* =========================================================
   Constants
========================================================= */

/*
 * 같은 줄 판정 허용값.
 *
 * Text / Icon의 Bounding Box가
 * 몇 px씩 차이나는 것을 고려.
 */
const ROW_TOLERANCE = 6;


/* =========================================================
   Matrix / Transform
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
   Node Helpers
========================================================= */

function hasChildren(node) {
  return (
    "children" in node &&
    node.children != null
  );
}


function isContainer(node) {
  return (
    node.type === "FRAME" ||
    node.type === "GROUP" ||
    node.type === "COMPONENT" ||
    node.type === "INSTANCE"
  );
}


function isSupportedRoot(node) {
  return (
    node.type === "FRAME" ||
    node.type === "INSTANCE" ||
    node.type === "COMPONENT" ||
    node.type === "GROUP"
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


/* =========================================================
   Paint Helpers
========================================================= */

function hasVisiblePaint(paints) {
  if (!Array.isArray(paints)) {
    return false;
  }

  return paints.some(paint => {
    if (paint.visible === false) {
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

  return node.effects.some(
    effect => effect.visible !== false
  );
}


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
   Garbage Detection
========================================================= */

function getGarbageReason(node) {

  if (
    "visible" in node &&
    node.visible === false
  ) {
    return "Hidden · visible=false";
  }


  if (
    "opacity" in node &&
    node.opacity === 0
  ) {
    return "Transparent · opacity=0";
  }


  if (node.type === "SLICE") {
    return "Slice Layer";
  }


  return null;
}


function isDefinitelyGarbage(node) {
  return (
    getGarbageReason(node) !== null
  );
}


/* =========================================================
   Mask / Clip / Composite
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


function needsBake(node) {
  if (!isContainer(node)) {
    return false;
  }


  /*
   * Clip Content
   */
  if (
    "clipsContent" in node &&
    node.clipsContent === true
  ) {
    return true;
  }


  /*
   * Mask
   */
  if (containsMask(node)) {
    return true;
  }


  /*
   * Container Opacity
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
   * Shadow / Blur 등의 Container Effect
   */
  if (hasVisibleEffects(node)) {
    return true;
  }


  return false;
}


/* =========================================================
   Root → Frame Conversion
========================================================= */

function copyProperty(
  source,
  target,
  key
) {
  try {
    if (
      key in source &&
      key in target &&
      source[key] !== figma.mixed
    ) {
      target[key] =
        source[key];
    }
  } catch (_) {}
}


function copyRootVisualProperties(
  source,
  frame
) {

  copyProperty(
    source,
    frame,
    "fills"
  );

  copyProperty(
    source,
    frame,
    "strokes"
  );

  copyProperty(
    source,
    frame,
    "effects"
  );


  try {
    if (
      "strokeWeight" in source
    ) {
      frame.strokeWeight =
        source.strokeWeight;
    }
  } catch (_) {}


  try {
    if (
      "strokeAlign" in source
    ) {
      frame.strokeAlign =
        source.strokeAlign;
    }
  } catch (_) {}


  try {
    if (
      "topLeftRadius" in source
    ) {
      frame.topLeftRadius =
        source.topLeftRadius;

      frame.topRightRadius =
        source.topRightRadius;

      frame.bottomLeftRadius =
        source.bottomLeftRadius;

      frame.bottomRightRadius =
        source.bottomRightRadius;
    }
  } catch (_) {}


  try {
    if (
      "opacity" in source
    ) {
      frame.opacity =
        source.opacity;
    }
  } catch (_) {}


  try {
    if (
      "blendMode" in source
    ) {
      frame.blendMode =
        source.blendMode;
    }
  } catch (_) {}


  /*
   * Root의 Clip은 유지.
   */
  try {
    if (
      "clipsContent" in source
    ) {
      frame.clipsContent =
        source.clipsContent;
    }
  } catch (_) {}
}


function replaceContainerWithFrame(
  source
) {
  const parent =
    source.parent;

  if (!parent) {
    throw new Error(
      "선택한 Root의 Parent를 찾을 수 없습니다."
    );
  }


  const sourceName =
    source.name;

  const width =
    source.width;

  const height =
    source.height;

  const absoluteTransform =
    source.absoluteTransform;


  let sourceIndex = -1;

  if ("children" in parent) {
    sourceIndex =
      parent.children.indexOf(
        source
      );
  }


  /*
   * Child들의 위치 저장
   */
  const children = [];

  if (hasChildren(source)) {

    for (
      const child of [...source.children]
    ) {

      children.push({
        node: child,

        absoluteTransform:
          child.absoluteTransform
      });
    }
  }


  /*
   * 새 Frame
   */
  const frame =
    figma.createFrame();


  frame.name =
    sourceName;


  /*
   * createFrame 기본 흰색 제거.
   */
  frame.fills = [];


  frame.resize(
    Math.max(width, 0.01),
    Math.max(height, 0.01)
  );


  frame.layoutMode =
    "NONE";


  if (
    source.type !== "GROUP"
  ) {

    copyRootVisualProperties(
      source,
      frame
    );
  }


  /*
   * 같은 sibling 위치에 넣기.
   */
  if (
    "insertChild" in parent &&
    sourceIndex >= 0
  ) {

    parent.insertChild(
      sourceIndex,
      frame
    );

  } else if (
    "appendChild" in parent
  ) {

    parent.appendChild(
      frame
    );
  }


  /*
   * 원래 위치 복원
   */
  try {
    frame.relativeTransform =
      absoluteToRelative(
        absoluteTransform,
        parent
      );
  } catch (_) {}


  /*
   * Children 이동
   */
  for (
    const snapshot of children
  ) {

    try {

      frame.appendChild(
        snapshot.node
      );


      snapshot.node.relativeTransform =
        absoluteToRelative(
          snapshot.absoluteTransform,
          frame
        );

    } catch (error) {

      console.warn(
        "Root child migration failed:",
        snapshot.node.name,
        error
      );
    }
  }


  try {
    source.remove();
  } catch (_) {}


  return frame;
}


function normalizeRootToFrame(
  node
) {

  /*
   * 이미 Frame
   */
  if (
    node.type === "FRAME"
  ) {

    return node;
  }


  /*
   * Root Instance
   */
  if (
    node.type === "INSTANCE"
  ) {

    try {

      const detached =
        node.detachInstance();


      if (
        detached.type === "FRAME"
      ) {
        return detached;
      }


      return replaceContainerWithFrame(
        detached
      );


    } catch (error) {

      console.warn(
        "Root Instance detach failed:",
        error
      );


      return replaceContainerWithFrame(
        node
      );
    }
  }


  /*
   * Component / Group
   */
  if (
    node.type === "COMPONENT" ||
    node.type === "GROUP"
  ) {

    return replaceContainerWithFrame(
      node
    );
  }


  throw new Error(
    `지원하지 않는 Root 타입: ${node.type}`
  );
}


/* =========================================================
   Instance Detach
========================================================= */

function detachInstancesRecursive(
  parent,
  stats
) {

  if (!hasChildren(parent)) {
    return;
  }


  const children =
    [...parent.children];


  for (
    const child of children
  ) {

    let target =
      child;


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
         * 실패 Instance는 그대로 두고
         * 이후 Bake 가능.
         */
        continue;
      }
    }


    if (
      hasChildren(target)
    ) {

      detachInstancesRecursive(
        target,
        stats
      );
    }
  }
}


/* =========================================================
   Inter Font
========================================================= */

const loadedInterStyles =
  new Set();


function mapFontStyleToInter(
  sourceStyle
) {

  const source =
    String(
      sourceStyle || ""
    )
      .toLowerCase()
      .replace(/[_-]/g, " ");


  const italic =
    source.includes("italic") ||
    source.includes("oblique");


  let weight =
    "Regular";


  if (
    source.includes("black") ||
    source.includes("heavy")
  ) {

    weight = "Black";

  } else if (
    source.includes("extra bold") ||
    source.includes("extrabold") ||
    source.includes("ultra bold")
  ) {

    weight = "Extra Bold";

  } else if (
    source.includes("semi bold") ||
    source.includes("semibold") ||
    source.includes("demi bold") ||
    source.includes("demibold")
  ) {

    weight = "Semi Bold";

  } else if (
    source.includes("bold")
  ) {

    weight = "Bold";

  } else if (
    source.includes("medium")
  ) {

    weight = "Medium";

  } else if (
    source.includes("extra light") ||
    source.includes("extralight") ||
    source.includes("ultra light")
  ) {

    weight = "Extra Light";

  } else if (
    source.includes("light")
  ) {

    weight = "Light";

  } else if (
    source.includes("thin")
  ) {

    weight = "Thin";
  }


  if (italic) {

    if (
      weight === "Regular"
    ) {

      return "Italic";
    }

    return `${weight} Italic`;
  }


  return weight;
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
      family: "Inter",
      style
    });


    loadedInterStyles.add(
      style
    );


    return style;


  } catch (_) {

    /*
     * Fallback
     */
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
  }
}


async function convertTextNodeToInter(
  node
) {

  if (
    node.type !== "TEXT"
  ) {

    return {
      converted: false,
      segments: 0
    };
  }


  /*
   * Empty Text
   */
  if (
    node.characters.length === 0
  ) {

    try {

      const style =
        await loadInterStyle(
          "Regular"
        );


      node.fontName = {
        family: "Inter",
        style
      };


      return {
        converted: true,
        segments: 1
      };

    } catch (_) {

      return {
        converted: false,
        segments: 0
      };
    }
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

      let sourceStyle =
        "Regular";


      if (
        segment.fontName &&
        segment.fontName !== figma.mixed
      ) {

        sourceStyle =
          segment.fontName.style;
      }


      const targetStyle =
        mapFontStyleToInter(
          sourceStyle
        );


      const loadedStyle =
        await loadInterStyle(
          targetStyle
        );


      try {

        node.setRangeFontName(
          segment.start,
          segment.end,
          {
            family: "Inter",
            style: loadedStyle
          }
        );


        converted++;

      } catch (error) {

        console.warn(
          "Text segment font conversion failed:",
          error
        );
      }
    }


    return {
      converted:
        converted > 0,

      segments:
        converted
    };


  } catch (error) {

    /*
     * fallback 전체 Regular
     */
    try {

      const style =
        await loadInterStyle(
          "Regular"
        );


      node.fontName = {
        family: "Inter",
        style
      };


      return {
        converted: true,
        segments: 1
      };


    } catch (_) {

      return {
        converted: false,
        segments: 0
      };
    }
  }
}


/* =========================================================
   Screenshot Detection
========================================================= */

function isScreenshotLayer(
  node,
  root
) {

  if (
    node.type !== "RECTANGLE"
  ) {
    return false;
  }


  if (!hasImageFill(node)) {
    return false;
  }


  if (
    !root ||
    root.width <= 0 ||
    root.height <= 0
  ) {
    return false;
  }


  const widthRatio =
    node.width / root.width;

  const heightRatio =
    node.height / root.height;


  /*
   * Screen 대부분을 차지하는
   * Image Fill → screenshot
   */
  return (
    widthRatio >= 0.7 &&
    heightRatio >= 0.5
  );
}


/* =========================================================
   Rename
========================================================= */

function normalizeLayerName(
  node,
  root
) {

  /*
   * Text
   */
  if (
    node.type === "TEXT"
  ) {

    if (
      renameTextToHyphen
    ) {

      node.name = "-";
    }

    return;
  }


  /*
   * Line
   */
  if (
    node.type === "LINE"
  ) {

    node.name =
      "line";

    return;
  }


  /*
   * Icon
   */
  if (
    isIconType(node)
  ) {

    node.name =
      "icon";

    return;
  }


  /*
   * Rectangle
   */
  if (
    node.type === "RECTANGLE"
  ) {

    if (
      hasImageFill(node)
    ) {

      if (
        isScreenshotLayer(
          node,
          root
        )
      ) {

        node.name =
          "screenshot";

      } else {

        node.name =
          "image";
      }

    } else {

      node.name =
        "shape";
    }

    return;
  }
}


/* =========================================================
   Container Visual Snapshot
========================================================= */

function snapshotContainerVisual(
  node
) {

  const data = {

    width:
      node.width,

    height:
      node.height,

    absoluteTransform:
      node.absoluteTransform,

    fills:
      null,

    strokes:
      null,

    strokeWeight:
      null,

    strokeAlign:
      null,

    effects:
      null,

    topLeftRadius:
      0,

    topRightRadius:
      0,

    bottomLeftRadius:
      0,

    bottomRightRadius:
      0
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


  if (
    "effects" in node &&
    node.effects !== figma.mixed
  ) {

    data.effects =
      node.effects;
  }


  try {

    data.topLeftRadius =
      node.topLeftRadius || 0;

    data.topRightRadius =
      node.topRightRadius || 0;

    data.bottomLeftRadius =
      node.bottomLeftRadius || 0;

    data.bottomRightRadius =
      node.bottomRightRadius || 0;

  } catch (_) {}


  return data;
}


/* =========================================================
   Visual Shell
========================================================= */

function createVisualShell(
  snapshot,
  root
) {

  const rect =
    figma.createRectangle();


  rect.name =
    "shape";


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


  if (
    snapshot.fills !== null
  ) {

    try {
      rect.fills =
        snapshot.fills;
    } catch (_) {}
  }


  if (
    snapshot.strokes !== null
  ) {

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


  if (
    snapshot.effects !== null
  ) {

    try {
      rect.effects =
        snapshot.effects;
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


  root.appendChild(
    rect
  );


  try {

    rect.relativeTransform =
      absoluteToRelative(
        snapshot.absoluteTransform,
        root
      );

  } catch (_) {}


  return rect;
}


/* =========================================================
   Bake
========================================================= */

async function createBakeSnapshot(
  node
) {

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

      x:
        bounds.x,

      y:
        bounds.y,

      width:
        bounds.width,

      height:
        bounds.height
    };


  } catch (error) {

    console.warn(
      "Bake failed:",
      node.name,
      error
    );


    return null;
  }
}


function createBakedScreenshot(
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


    rect.name =
      "screenshot";


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
        type:
          "IMAGE",

        scaleMode:
          "FILL",

        imageHash:
          image.hash
      }
    ];


    root.appendChild(
      rect
    );


    rect.relativeTransform =
      positionToRelativeTransform(
        snapshot.x,
        snapshot.y,
        root
      );


    return rect;


  } catch (error) {

    console.warn(
      "Screenshot creation failed:",
      error
    );


    return null;
  }
}


/* =========================================================
   Flatten Plan
========================================================= */

async function buildFlattenPlan(
  root,
  stats
) {

  const plan =
    [];


  async function visit(node) {

    /* -----------------------------------------
       Garbage
    ----------------------------------------- */

    if (
      isDefinitelyGarbage(
        node
      )
    ) {

      if (
        approvedGarbageIds.has(
          node.id
        )
      ) {

        plan.push({
          type:
            "garbage",

          node
        });


        return;
      }


      /*
       * 사용자가 승인하지 않은 Garbage 후보.
       *
       * 삭제하지 않는다.
       */
      plan.push({
        type:
          "preserve",

        node
      });


      stats.protectedGarbage++;


      return;
    }


    /* -----------------------------------------
       Container
    ----------------------------------------- */

    if (
      isContainer(node)
    ) {

      /*
       * 구조를 없애면 화면이 변하는
       * Composite Container
       */
      if (
        needsBake(node)
      ) {

        const screenshot =
          await createBakeSnapshot(
            node
          );


        if (screenshot) {

          plan.push({
            type:
              "bake",

            source:
              node,

            snapshot:
              screenshot
          });


          stats.bakedAreas++;


          return;
        }


        /*
         * Bake마저 실패했다면
         * 화면 보호를 위해 Container 보존.
         */
        plan.push({
          type:
            "preserve",

          node
        });


        stats.preservedAreas++;


        return;
      }


      /*
       * Frame 자체에 배경/Stroke가 있으면
       * Container 삭제 전 Shape으로 재현.
       */
      if (
        hasOwnVisual(node)
      ) {

        plan.push({
          type:
            "shell",

          snapshot:
            snapshotContainerVisual(
              node
            )
        });
      }


      /*
       * Children을 Recursive Flatten
       */
      if (
        hasChildren(node)
      ) {

        const children =
          [...node.children];


        for (
          const child of children
        ) {

          await visit(
            child
          );
        }
      }


      return;
    }


    /* -----------------------------------------
       Normal Leaf
    ----------------------------------------- */

    plan.push({
      type:
        "leaf",

      node,

      absoluteTransform:
        node.absoluteTransform
    });
  }


  const children =
    [...root.children];


  for (
    const child of children
  ) {

    await visit(
      child
    );
  }


  return plan;
}


/* =========================================================
   Execute Flatten Plan
========================================================= */

async function executeFlattenPlan(
  root,
  plan,
  stats
) {

  const originalChildren =
    [...root.children];


  /*
   * Garbage 삭제
   */
  for (
    const item of plan
  ) {

    if (
      item.type !== "garbage"
    ) {
      continue;
    }


    try {

      item.node.remove();

      stats.removedGarbage++;

    } catch (_) {}
  }


  /*
   * 결과 Layer 생성 / 이동
   */
  for (
    const item of plan
  ) {

    if (
      item.type === "garbage"
    ) {
      continue;
    }


    /* -----------------------------------------
       Shell
    ----------------------------------------- */

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


    /* -----------------------------------------
       Bake
    ----------------------------------------- */

    if (
      item.type === "bake"
    ) {

      const screenshot =
        createBakedScreenshot(
          item.snapshot,
          root
        );


      if (screenshot) {

        stats.finalLayers++;
      }


      continue;
    }


    /* -----------------------------------------
       Preserve
    ----------------------------------------- */

    if (
      item.type === "preserve"
    ) {

      try {

        const absoluteTransform =
          item.node.absoluteTransform;


        root.appendChild(
          item.node
        );


        item.node.relativeTransform =
          absoluteToRelative(
            absoluteTransform,
            root
          );


        stats.finalLayers++;

      } catch (_) {}


      continue;
    }


    /* -----------------------------------------
       Leaf
    ----------------------------------------- */

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

        root.appendChild(
          node
        );


        node.relativeTransform =
          absoluteToRelative(
            item.absoluteTransform,
            root
          );


        /*
         * Text → Inter
         */
        if (
          node.type === "TEXT"
        ) {

          const fontResult =
            await convertTextNodeToInter(
              node
            );


          if (
            fontResult.converted
          ) {

            stats.convertedTexts++;

            stats.convertedFontSegments +=
              fontResult.segments;

          } else {

            stats.failedFontConversions++;
          }
        }


        /*
         * Naming
         */
        normalizeLayerName(
          node,
          root
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
   * 사용이 끝난 기존 Container 제거.
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


    const preserve =
      plan.some(
        item =>
          item.type ===
            "preserve" &&
          item.node ===
            child
      );


    const leaf =
      plan.some(
        item =>
          item.type ===
            "leaf" &&
          item.node ===
            child
      );


    if (
      preserve ||
      leaf
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
   Screen Position Sorting
========================================================= */

function rectanglesOverlap(
  a,
  b
) {

  if (
    !a.bounds ||
    !b.bounds
  ) {
    return false;
  }


  return !(
    a.bounds.x +
      a.bounds.width <=
        b.bounds.x ||

    b.bounds.x +
      b.bounds.width <=
        a.bounds.x ||

    a.bounds.y +
      a.bounds.height <=
        b.bounds.y ||

    b.bounds.y +
      b.bounds.height <=
        a.bounds.y
  );
}


/*
 * 화면 좌표 기준으로
 *
 * 1. Top → Bottom
 * 2. 같은 Row → Left → Right
 *
 * 단, 실제 영역이 서로 겹치는 Layer는
 * Z-order가 화면에 영향을 줄 가능성이 있으므로
 * 기존 상대 순서를 우선한다.
 */
function sortLayersByScreenPosition(
  root
) {

  if (
    !hasChildren(root)
  ) {
    return;
  }


  const original =
    [...root.children];


  const items =
    original.map(
      (node, originalIndex) => {

        const bounds =
          node.absoluteBoundingBox;


        return {

          node,

          bounds,

          x:
            bounds
              ? bounds.x
              : 0,

          y:
            bounds
              ? bounds.y
              : 0,

          originalIndex
        };
      }
    );


  items.sort(
    (a, b) => {

      /*
       * 서로 겹쳐 있다면
       * 기존 Z-order 우선.
       */
      if (
        rectanglesOverlap(
          a,
          b
        )
      ) {

        return (
          a.originalIndex -
          b.originalIndex
        );
      }


      /*
       * 같은 Row
       */
      if (
        Math.abs(
          a.y - b.y
        ) <= ROW_TOLERANCE
      ) {

        const xDiff =
          a.x - b.x;


        if (
          Math.abs(
            xDiff
          ) > 0.1
        ) {

          return xDiff;
        }


        return (
          a.originalIndex -
          b.originalIndex
        );
      }


      /*
       * Top → Bottom
       */
      return (
        a.y - b.y
      );
    }
  );


  /*
   * Figma children array는
   * 앞쪽이 아래쪽 z-order,
   * 뒤쪽이 위쪽 z-order이다.
   *
   * Layer Panel에서는 반대로 보일 수 있으므로
   * 원하는 "위→아래 읽기 순서"가
   * Layer Panel에서도 위→아래가 되도록
   * 역순으로 삽입.
   *
   * 서로 겹치는 항목은 위 comparator에서
   * 기존 order가 우선된다.
   */
  const panelOrder =
    [...items].reverse();


  for (
    let index = 0;
    index < panelOrder.length;
    index++
  ) {

    try {

      root.insertChild(
        index,
        panelOrder[index].node
      );

    } catch (error) {

      console.warn(
        "Layer order failed:",
        panelOrder[index].node.name,
        error
      );
    }
  }
}


/* =========================================================
   Prepare Root
========================================================= */

function prepareRoot(
  root
) {

  /*
   * 최상위 Frame 자체 Auto Layout 해제.
   */
  try {

    if (
      root.layoutMode !==
      "NONE"
    ) {

      root.layoutMode =
        "NONE";
    }

  } catch (_) {}


  /*
   * Screen Clip은 그대로 유지.
   */
}


/* =========================================================
   Analysis
========================================================= */

function analyzeScreen(
  root
) {

  const result = {

    total:
      0,

    garbage:
      0,

    garbageItems:
      [],

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


  function walk(
    node,
    path
  ) {

    result.total++;


    const currentPath =
      path
        ? `${path} / ${node.name}`
        : node.name;


    /* ---------------------------------
       Garbage
    --------------------------------- */

    const garbageReason =
      getGarbageReason(
        node
      );


    if (
      garbageReason
    ) {

      result.garbage++;


      result.garbageItems.push({

        id:
          node.id,

        name:
          node.name,

        type:
          node.type,

        reason:
          garbageReason,

        path:
          currentPath
      });
    }


    /* ---------------------------------
       Container
    --------------------------------- */

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


    /* ---------------------------------
       Instance
    --------------------------------- */

    if (
      node.type === "INSTANCE"
    ) {

      result.instances++;
    }


    /* ---------------------------------
       Auto Layout
    --------------------------------- */

    if (
      "layoutMode" in node &&
      node.layoutMode !== "NONE"
    ) {

      result.autoLayouts++;
    }


    /* ---------------------------------
       Mask
    --------------------------------- */

    if (
      "isMask" in node &&
      node.isMask === true
    ) {

      result.masks++;
    }


    /* ---------------------------------
       Clip
    --------------------------------- */

    if (
      node !== root &&
      "clipsContent" in node &&
      node.clipsContent === true
    ) {

      result.clips++;
    }


    /* ---------------------------------
       Text
    --------------------------------- */

    if (
      node.type === "TEXT"
    ) {

      result.text++;


      try {

        const segments =
          node.getStyledTextSegments(
            ["fontName"]
          );


        const nonInter =
          segments.some(
            segment => {

              return (
                !segment.fontName ||
                segment.fontName ===
                  figma.mixed ||
                segment.fontName.family !==
                  "Inter"
              );
            }
          );


        if (
          nonInter
        ) {

          result.nonInterText++;
        }

      } catch (_) {

        result.nonInterText++;
      }
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


    if (
      hasChildren(node)
    ) {

      for (
        const child of node.children
      ) {

        walk(
          child,
          currentPath
        );
      }
    }
  }


  walk(
    root,
    ""
  );


  return result;
}


/* =========================================================
   Clean Screen
========================================================= */

async function cleanScreen(
  root
) {

  const stats = {

    detachedInstances:
      0,

    removedGarbage:
      0,

    protectedGarbage:
      0,

    removedContainers:
      0,

    movedLayers:
      0,

    visualShells:
      0,

    bakedAreas:
      0,

    preservedAreas:
      0,

    convertedTexts:
      0,

    convertedFontSegments:
      0,

    failedFontConversions:
      0,

    finalLayers:
      0
  };


  /*
   * Nested Instances Detach
   */
  detachInstancesRecursive(
    root,
    stats
  );


  /*
   * 현재 구조 기준 Plan.
   *
   * 구조를 변경하기 전에
   * screenshot Bake도 여기서 수행.
   */
  const plan =
    await buildFlattenPlan(
      root,
      stats
    );


  /*
   * Root Auto Layout 해제.
   */
  prepareRoot(
    root
  );


  /*
   * Flatten.
   */
  await executeFlattenPlan(
    root,
    plan,
    stats
  );


  /*
   * 화면 좌표 기반 Layer 정렬.
   */
  sortLayersByScreenPosition(
    root
  );


  return stats;
}


/* =========================================================
   UI MESSAGE
========================================================= */

figma.ui.onmessage =
async (msg) => {


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
     SELECT GARBAGE LAYER
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
        node.type === "DOCUMENT" ||
        node.type === "PAGE"
      ) {

        return;
      }


      figma.currentPage.selection =
        [node];


      figma.viewport
        .scrollAndZoomIntoView(
          [node]
        );


    } catch (error) {

      console.warn(
        "Layer selection failed:",
        error
      );
    }


    return;
  }


  /* =====================================================
     CURRENT SELECTION
  ===================================================== */

  const selection =
    figma.currentPage.selection;


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


  const selectedRoots =
    selection.filter(
      node =>
        isSupportedRoot(
          node
        )
    );


  if (
    selectedRoots.length !==
    selection.length
  ) {

    figma.ui.postMessage({

      type:
        "error",

      message:
`선택한 최상위 Layer를 Screen으로 사용할 수 없습니다.

지원 타입
• Frame
• Instance
• Component
• Group

Frame이 아닌 경우 Clean 실행 시 자동으로 Frame으로 변환됩니다.`
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
      selectedRoots.map(
        root => {

          return {

            name:
              root.name,

            rootType:
              root.type,

            willConvertToFrame:
              root.type !== "FRAME",

            ...analyzeScreen(
              root
            )
          };
        }
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
        msg.garbageIds || []
      );


    renameTextToHyphen =
      msg.renameTextToHyphen ===
      true;


    figma.ui.postMessage({
      type:
        "processing"
    });


    try {

      /*
       * Inter 사전 Load
       */
      await loadInterStyle(
        "Regular"
      );


      /*
       * Root 정규화
       */
      const roots = [];


      for (
        const selectedRoot of
        selectedRoots
      ) {

        const root =
          normalizeRootToFrame(
            selectedRoot
          );


        roots.push(
          root
        );
      }


      const total = {

        screens:
          roots.length,

        rootConversions:
          selectedRoots.filter(
            node =>
              node.type !== "FRAME"
          ).length,

        detachedInstances:
          0,

        removedGarbage:
          0,

        protectedGarbage:
          0,

        removedContainers:
          0,

        movedLayers:
          0,

        visualShells:
          0,

        bakedAreas:
          0,

        preservedAreas:
          0,

        convertedTexts:
          0,

        convertedFontSegments:
          0,

        failedFontConversions:
          0,

        finalLayers:
          0
      };


      for (
        const root of roots
      ) {

        const result =
          await cleanScreen(
            root
          );


        for (
          const key of
          Object.keys(result)
        ) {

          if (
            key in total
          ) {

            total[key] +=
              result[key];
          }
        }
      }


      /*
       * 결과 Screen 선택
       */
      figma.currentPage.selection =
        roots;


      figma.viewport
        .scrollAndZoomIntoView(
          roots
        );


      figma.ui.postMessage({

        type:
          "complete",

        result:
          total
      });


      figma.notify(
        `Cleanup 완료 · ${total.finalLayers}개 Layer`
      );


    } catch (error) {

      console.error(
        error
      );


      figma.ui.postMessage({

        type:
          "error",

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


    return;
  }
};
