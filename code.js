figma.showUI(__html__, {
  width: 440,
  height: 760,
  themeColors: true
});


/* =========================================================
   SCREEN LAYER CLEANER

   제1법칙
   ---------------------------------------------------------
   Before / After Visual이 달라지면 Cleanup 전체 Rollback.

   처리 방식
   ---------------------------------------------------------
   Original
      ↓
   Clone 생성
      ↓
   Clone만 Cleanup
      ↓
   Original PNG / Clean PNG 비교
      ↓
   같음   → Original 제거 / Clean 결과 Commit
   다름   → Clone 제거 / Original 유지

========================================================= */


/* =========================================================
   GLOBAL
========================================================= */

let approvedGarbageIds = new Set();

let renameTextToHyphen = false;

let convertFontToInter = false;

const ROW_TOLERANCE = 6;


/* =========================================================
   TRANSFORM
========================================================= */

function multiplyTransform(a, b) {
  return [
    [
      a[0][0] * b[0][0] + a[0][1] * b[1][0],
      a[0][0] * b[0][1] + a[0][1] * b[1][1],
      a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2]
    ],
    [
      a[1][0] * b[0][0] + a[1][1] * b[1][0],
      a[1][0] * b[0][1] + a[1][1] * b[1][1],
      a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2]
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
    throw new Error("Transform matrix cannot be inverted.");
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
  const inverse =
    invertTransform(
      parent.absoluteTransform
    );

  return multiplyTransform(
    inverse,
    absoluteTransform
  );
}


function positionToRelativeTransform(
  x,
  y,
  parent
) {
  return absoluteToRelative(
    [
      [1, 0, x],
      [0, 1, y]
    ],
    parent
  );
}


/* =========================================================
   NODE HELPERS
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


/* =========================================================
   PAINT
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


function hasVisibleEffects(node) {
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


/* =========================================================
   GARBAGE
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


  if (
    node.type === "SLICE"
  ) {
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
   MASK / CLIP
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


/*
 * clipsContent=true라고 무조건 Bake하지 않는다.
 *
 * 실제 Child가 부모 영역 밖으로 나가
 * 잘리고 있을 때만 true.
 */
function actuallyClipsChildren(node) {

  if (
    !("clipsContent" in node) ||
    node.clipsContent !== true
  ) {
    return false;
  }


  if (!hasChildren(node)) {
    return false;
  }


  const parentBounds =
    node.absoluteBoundingBox;


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


  for (const child of node.children) {

    if (
      "visible" in child &&
      child.visible === false
    ) {
      continue;
    }


    const bounds =
      child.absoluteRenderBounds ||
      child.absoluteBoundingBox;


    if (!bounds) {
      continue;
    }


    const childRight =
      bounds.x +
      bounds.width;

    const childBottom =
      bounds.y +
      bounds.height;


    if (
      bounds.x < left - 0.5 ||
      bounds.y < top - 0.5 ||
      childRight > right + 0.5 ||
      childBottom > bottom + 0.5
    ) {
      return true;
    }
  }


  return false;
}


/*
 * 1 Depth화할 때
 * 동일 Visual을 보장하기 어려운 영역.
 *
 * 이 경우 해당 영역만 screenshot Bake.
 */
function needsBake(node) {

  if (!isContainer(node)) {
    return false;
  }


  if (
    containsMask(node)
  ) {
    return true;
  }


  if (
    actuallyClipsChildren(node)
  ) {
    return true;
  }


  if (
    "opacity" in node &&
    node.opacity !== 1
  ) {
    return true;
  }


  if (
    "blendMode" in node &&
    node.blendMode !== "PASS_THROUGH" &&
    node.blendMode !== "NORMAL"
  ) {
    return true;
  }


  if (
    hasVisibleEffects(node)
  ) {
    return true;
  }


  return false;
}


/* =========================================================
   ROOT → FRAME
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
    frame.strokeWeight =
      source.strokeWeight;
  } catch (_) {}


  try {
    frame.strokeAlign =
      source.strokeAlign;
  } catch (_) {}


  try {

    frame.topLeftRadius =
      source.topLeftRadius;

    frame.topRightRadius =
      source.topRightRadius;

    frame.bottomLeftRadius =
      source.bottomLeftRadius;

    frame.bottomRightRadius =
      source.bottomRightRadius;

  } catch (_) {}


  try {
    frame.opacity =
      source.opacity;
  } catch (_) {}


  try {
    frame.blendMode =
      source.blendMode;
  } catch (_) {}


  try {
    frame.clipsContent =
      source.clipsContent;
  } catch (_) {}
}


function replaceContainerWithFrame(
  source
) {

  const parent =
    source.parent;


  if (
    !parent ||
    !("children" in parent)
  ) {
    throw new Error(
      "Root의 Parent를 찾을 수 없습니다."
    );
  }


  const index =
    parent.children.indexOf(
      source
    );


  const name =
    source.name;

  const width =
    source.width;

  const height =
    source.height;

  const absoluteTransform =
    source.absoluteTransform;


  const children = [];


  if (
    hasChildren(source)
  ) {

    for (
      const child of
      [...source.children]
    ) {

      children.push({
        node: child,

        absoluteTransform:
          child.absoluteTransform
      });
    }
  }


  const frame =
    figma.createFrame();


  /*
   * createFrame 기본 흰색 제거.
   */
  frame.fills = [];


  frame.name =
    name;


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


  parent.insertChild(
    Math.max(index, 0),
    frame
  );


  try {

    frame.relativeTransform =
      absoluteToRelative(
        absoluteTransform,
        parent
      );

  } catch (_) {}


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
        "Root Child 이동 실패:",
        snapshot.node.name,
        error
      );
    }
  }


  source.remove();


  return frame;
}


function normalizeRootToFrame(node) {

  if (
    node.type === "FRAME"
  ) {
    return node;
  }


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


    } catch (_) {

      return replaceContainerWithFrame(
        node
      );
    }
  }


  if (
    node.type === "GROUP" ||
    node.type === "COMPONENT"
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
   INSTANCE
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


  for (const child of children) {

    let target =
      child;


    if (
      child.type === "INSTANCE"
    ) {

      try {

        target =
          child.detachInstance();


        stats.detachedInstances++;

      } catch (_) {

        /*
         * 실패하면 그대로 두고
         * 이후 Preserve/Bake.
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
   INTER FONT
========================================================= */

const loadedInterStyles =
  new Set();


function mapFontStyleToInter(
  styleName
) {

  const value =
    String(
      styleName || ""
    )
      .toLowerCase()
      .replace(/[_-]/g, " ");


  const italic =
    value.includes("italic") ||
    value.includes("oblique");


  let weight =
    "Regular";


  if (
    value.includes("black") ||
    value.includes("heavy")
  ) {

    weight =
      "Black";

  } else if (
    value.includes("extra bold") ||
    value.includes("extrabold")
  ) {

    weight =
      "Extra Bold";

  } else if (
    value.includes("semi bold") ||
    value.includes("semibold") ||
    value.includes("demi bold")
  ) {

    weight =
      "Semi Bold";

  } else if (
    value.includes("bold")
  ) {

    weight =
      "Bold";

  } else if (
    value.includes("medium")
  ) {

    weight =
      "Medium";

  } else if (
    value.includes("extra light") ||
    value.includes("extralight")
  ) {

    weight =
      "Extra Light";

  } else if (
    value.includes("light")
  ) {

    weight =
      "Light";

  } else if (
    value.includes("thin")
  ) {

    weight =
      "Thin";
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


    loadedInterStyles.add(
      style
    );


    return style;


  } catch (_) {

    if (
      !loadedInterStyles.has(
        "Regular"
      )
    ) {

      await figma.loadFontAsync({
        family:
          "Inter",

        style:
          "Regular"
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


  if (
    node.characters.length === 0
  ) {

    try {

      const style =
        await loadInterStyle(
          "Regular"
        );


      node.fontName = {
        family:
          "Inter",

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

      const sourceStyle =
        segment.fontName &&
        segment.fontName !== figma.mixed
          ? segment.fontName.style
          : "Regular";


      const wanted =
        mapFontStyleToInter(
          sourceStyle
        );


      const loaded =
        await loadInterStyle(
          wanted
        );


      node.setRangeFontName(
        segment.start,
        segment.end,
        {
          family:
            "Inter",

          style:
            loaded
        }
      );


      converted++;
    }


    return {
      converted:
        converted > 0,

      segments:
        converted
    };


  } catch (_) {

    return {
      converted: false,
      segments: 0
    };
  }
}


/* =========================================================
   SCREENSHOT / NAME
========================================================= */

function isScreenshotLayer(
  node,
  root
) {

  if (
    node.type !== "RECTANGLE" ||
    !hasImageFill(node)
  ) {
    return false;
  }


  if (
    root.width <= 0 ||
    root.height <= 0
  ) {
    return false;
  }


  const widthRatio =
    node.width /
    root.width;

  const heightRatio =
    node.height /
    root.height;


  return (
    widthRatio >= 0.7 &&
    heightRatio >= 0.5
  );
}


function normalizeLayerName(
  node,
  root
) {

  /*
   * TEXT
   */
  if (
    node.type === "TEXT"
  ) {

    if (
      renameTextToHyphen
    ) {

      node.name =
        "-";
    }


    return;
  }


  /*
   * LINE
   */
  if (
    node.type === "LINE"
  ) {

    node.name =
      "line";

    return;
  }


  /*
   * ICON
   */
  if (
    isIconType(node)
  ) {

    node.name =
      "icon";

    return;
  }


  /*
   * RECTANGLE
   */
  if (
    node.type === "RECTANGLE"
  ) {

    if (
      hasImageFill(node)
    ) {

      node.name =
        isScreenshotLayer(
          node,
          root
        )
          ? "screenshot"
          : "image";

    } else {

      node.name =
        "shape";
    }
  }
}


/* =========================================================
   CONTAINER VISUAL
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

    effects:
      null,

    strokeWeight:
      null,

    strokeAlign:
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


  try {

    if (
      node.fills !==
      figma.mixed
    ) {

      data.fills =
        node.fills;
    }

  } catch (_) {}


  try {

    if (
      node.strokes !==
      figma.mixed
    ) {

      data.strokes =
        node.strokes;
    }

  } catch (_) {}


  try {
    data.effects =
      node.effects;
  } catch (_) {}


  try {
    data.strokeWeight =
      node.strokeWeight;
  } catch (_) {}


  try {
    data.strokeAlign =
      node.strokeAlign;
  } catch (_) {}


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


  try {
    if (
      snapshot.fills !== null
    ) {
      rect.fills =
        snapshot.fills;
    }
  } catch (_) {}


  try {
    if (
      snapshot.strokes !== null
    ) {
      rect.strokes =
        snapshot.strokes;
    }
  } catch (_) {}


  try {
    if (
      snapshot.effects !== null
    ) {
      rect.effects =
        snapshot.effects;
    }
  } catch (_) {}


  try {
    rect.strokeWeight =
      snapshot.strokeWeight;
  } catch (_) {}


  try {
    rect.strokeAlign =
      snapshot.strokeAlign;
  } catch (_) {}


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


  rect.relativeTransform =
    absoluteToRelative(
      snapshot.absoluteTransform,
      root
    );


  return rect;
}


/* =========================================================
   BAKE → SCREENSHOT
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
        format:
          "PNG",

        constraint: {
          type:
            "SCALE",

          value:
            2
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


  } catch (_) {

    return null;
  }
}


function createBakedScreenshot(
  snapshot,
  root
) {

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
}


/* =========================================================
   FLATTEN PLAN
========================================================= */

async function buildFlattenPlan(
  root,
  stats
) {

  const plan =
    [];


  async function visit(node) {

    /*
     * GARBAGE
     */
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
       * 승인하지 않은 Garbage는 그대로 보존.
       */
      plan.push({
        type:
          "preserve",

        node
      });


      stats.protectedGarbage++;


      return;
    }


    /*
     * CONTAINER
     */
    if (
      isContainer(node)
    ) {

      if (
        needsBake(node)
      ) {

        const snapshot =
          await createBakeSnapshot(
            node
          );


        if (
          snapshot
        ) {

          plan.push({
            type:
              "bake",

            node,

            snapshot
          });


          stats.bakedAreas++;


          return;
        }


        /*
         * Bake 실패 → 구조 유지.
         *
         * 1 Depth보다 화면 보존 우선.
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
       * Container 자체 Background / Stroke.
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


      if (
        hasChildren(node)
      ) {

        for (
          const child of
          [...node.children]
        ) {

          await visit(
            child
          );
        }
      }


      return;
    }


    /*
     * LEAF
     */
    plan.push({
      type:
        "leaf",

      node,

      absoluteTransform:
        node.absoluteTransform
    });
  }


  for (
    const child of
    [...root.children]
  ) {

    await visit(
      child
    );
  }


  return plan;
}


/* =========================================================
   EXECUTE PLAN
========================================================= */

async function executeFlattenPlan(
  root,
  plan,
  stats
) {

  const originalChildren =
    [...root.children];


  /*
   * Garbage
   */
  for (
    const item of plan
  ) {

    if (
      item.type !==
      "garbage"
    ) {
      continue;
    }


    try {

      item.node.remove();

      stats.removedGarbage++;

    } catch (_) {}
  }


  /*
   * Build Result
   */
  for (
    const item of plan
  ) {

    if (
      item.type ===
      "garbage"
    ) {
      continue;
    }


    /*
     * SHELL
     */
    if (
      item.type ===
      "shell"
    ) {

      createVisualShell(
        item.snapshot,
        root
      );


      stats.visualShells++;
      stats.finalLayers++;


      continue;
    }


    /*
     * BAKE
     */
    if (
      item.type ===
      "bake"
    ) {

      createBakedScreenshot(
        item.snapshot,
        root
      );


      stats.finalLayers++;


      continue;
    }


    /*
     * PRESERVE
     */
    if (
      item.type ===
      "preserve"
    ) {

      const transform =
        item.node.absoluteTransform;


      root.appendChild(
        item.node
      );


      item.node.relativeTransform =
        absoluteToRelative(
          transform,
          root
        );


      stats.finalLayers++;


      continue;
    }


    /*
     * LEAF
     */
    if (
      item.type ===
      "leaf"
    ) {

      const node =
        item.node;


      const transform =
        item.absoluteTransform;


      root.appendChild(
        node
      );


      node.relativeTransform =
        absoluteToRelative(
          transform,
          root
        );


      /*
       * Font Conversion
       *
       * 옵션일 때만.
       */
      if (
        node.type === "TEXT" &&
        convertFontToInter
      ) {

        const font =
          await convertTextNodeToInter(
            node
          );


        if (
          font.converted
        ) {

          stats.convertedTexts++;

          stats.convertedFontSegments +=
            font.segments;

        } else {

          stats.failedFontConversions++;
        }
      }


      normalizeLayerName(
        node,
        root
      );


      stats.movedLayers++;
      stats.finalLayers++;
    }
  }


  /*
   * 기존 Container 제거
   */
  for (
    const child of
    originalChildren
  ) {

    if (
      !child ||
      child.removed
    ) {
      continue;
    }


    const preserved =
      plan.some(
        item =>
          item.type === "preserve" &&
          item.node === child
      );


    const leaf =
      plan.some(
        item =>
          item.type === "leaf" &&
          item.node === child
      );


    if (
      preserved ||
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
   SAFE LAYER ORDER
========================================================= */

function getBounds(node) {

  const bounds =
    node.absoluteBoundingBox;


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


function boundsOverlap(a, b) {

  if (!a || !b) {
    return false;
  }


  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}


function compareSpatial(a, b) {

  if (
    !a.bounds ||
    !b.bounds
  ) {

    return (
      a.originalPanelIndex -
      b.originalPanelIndex
    );
  }


  /*
   * 같은 Row → Left → Right
   */
  if (
    Math.abs(
      a.bounds.y -
      b.bounds.y
    ) <= ROW_TOLERANCE
  ) {

    const x =
      a.bounds.x -
      b.bounds.x;


    if (
      Math.abs(x) >
      0.1
    ) {

      return x;
    }
  }


  /*
   * Top → Bottom
   */
  const y =
    a.bounds.y -
    b.bounds.y;


  if (
    Math.abs(y) >
    0.1
  ) {

    return y;
  }


  return (
    a.originalPanelIndex -
    b.originalPanelIndex
  );
}


/*
 * 겹친 Layer의 기존 Z-order를
 * Constraint로 등록한 Topological Sort.
 */
function sortLayersSafely(
  root
) {

  if (
    !hasChildren(root) ||
    root.children.length <= 1
  ) {
    return;
  }


  /*
   * Layer Panel은 children 역순.
   */
  const originalPanel =
    [...root.children]
      .reverse();


  const items =
    originalPanel.map(
      (node, index) => ({
        node,

        bounds:
          getBounds(node),

        originalPanelIndex:
          index,

        outgoing:
          new Set(),

        indegree:
          0
      })
    );


  /*
   * 겹치는 Layer → 기존 순서 강제.
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

      const a =
        items[i];

      const b =
        items[j];


      if (
        boundsOverlap(
          a.bounds,
          b.bounds
        )
      ) {

        a.outgoing.add(
          b
        );

        b.indegree++;
      }
    }
  }


  const available =
    items.filter(
      item =>
        item.indegree === 0
    );


  const sorted =
    [];


  while (
    available.length > 0
  ) {

    available.sort(
      compareSpatial
    );


    const current =
      available.shift();


    sorted.push(
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
   * 안전장치.
   */
  if (
    sorted.length !==
    items.length
  ) {

    console.warn(
      "Safe ordering 실패 → 기존 Z-order 유지"
    );

    return;
  }


  /*
   * Panel → children 역순.
   */
  const finalChildren =
    sorted
      .map(item => item.node)
      .reverse();


  for (
    let i = 0;
    i < finalChildren.length;
    i++
  ) {

    root.insertChild(
      i,
      finalChildren[i]
    );
  }
}


/* =========================================================
   PREPARE ROOT
========================================================= */

function prepareRoot(root) {

  try {

    if (
      root.layoutMode !== "NONE"
    ) {

      /*
       * 이미 Child 위치를 absolute 기준으로 저장한 후
       * 실행되므로 Auto Layout 해제.
       */
      root.layoutMode =
        "NONE";
    }

  } catch (_) {}


  /*
   * Root clipsContent는 변경하지 않는다.
   */
}


/* =========================================================
   VISUAL VERIFICATION
========================================================= */

/*
 * 동일 조건으로 Screen PNG Export.
 *
 * 구조가 달라도 최종 Pixel이 완전히 동일하면
 * PNG bytes 역시 동일한 결과가 나오는 것을 이용.
 */
async function exportVisual(node) {

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
}


function byteArraysEqual(a, b) {

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
   ANALYZE
========================================================= */

function analyzeScreen(root) {

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


    /*
     * Garbage
     */
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


    /*
     * Container
     */
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
      node.type ===
      "INSTANCE"
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
      actuallyClipsChildren(node)
    ) {

      result.clips++;
    }


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
            segment =>
              !segment.fontName ||
              segment.fontName === figma.mixed ||
              segment.fontName.family !== "Inter"
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
        const child of
        node.children
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
   CLEAN ROOT
========================================================= */

async function cleanWorkingRoot(root) {

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


  detachInstancesRecursive(
    root,
    stats
  );


  const plan =
    await buildFlattenPlan(
      root,
      stats
    );


  prepareRoot(
    root
  );


  await executeFlattenPlan(
    root,
    plan,
    stats
  );


  sortLayersSafely(
    root
  );


  return stats;
}


/* =========================================================
   TRANSACTIONAL CLEANUP
========================================================= */

/*
 * 원본에는 절대 직접 작업하지 않는다.
 */
async function cleanWithVisualProtection(
  originalRoot
) {

  const originalParent =
    originalRoot.parent;


  if (
    !originalParent ||
    !("children" in originalParent)
  ) {
    throw new Error(
      "Screen Parent를 찾을 수 없습니다."
    );
  }


  const originalIndex =
    originalParent.children.indexOf(
      originalRoot
    );


  /*
   * 1.
   * Before Visual Export.
   */
  const beforeVisual =
    await exportVisual(
      originalRoot
    );


  /*
   * 2.
   * Working Clone.
   */
  let working =
    originalRoot.clone();


  originalParent.insertChild(
    originalIndex + 1,
    working
  );


  /*
   * 3.
   * Clone Root → Frame.
   */
  working =
    normalizeRootToFrame(
      working
    );


  /*
   * 4.
   * Cleanup.
   */
  const stats =
    await cleanWorkingRoot(
      working
    );


  /*
   * 5.
   * After Visual.
   */
  const afterVisual =
    await exportVisual(
      working
    );


  /*
   * 6.
   * Pixel Verification.
   */
  const visualMatch =
    byteArraysEqual(
      beforeVisual,
      afterVisual
    );


  /*
   * FAILED
   *
   * Clone 삭제.
   * Original 그대로.
   */
  if (
    !visualMatch
  ) {

    try {
      working.remove();
    } catch (_) {}


    return {
      success:
        false,

      root:
        originalRoot,

      stats,

      visualMatch:
        false
    };
  }


  /*
   * PASS
   *
   * Clean Root를 원래 위치로 이동.
   */
  originalParent.insertChild(
    originalIndex,
    working
  );


  /*
   * Original 삭제.
   */
  originalRoot.remove();


  return {
    success:
      true,

    root:
      working,

    stats,

    visualMatch:
      true
  };
}


/* =========================================================
   UI
========================================================= */

figma.ui.onmessage =
async msg => {


  /* -------------------------------------------------------
     Select Garbage
  ------------------------------------------------------- */

  if (
    msg.type ===
    "select-layer"
  ) {

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


    return;
  }


  /* -------------------------------------------------------
     Selection
  ------------------------------------------------------- */

  const selection =
    [...figma.currentPage.selection];


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
`지원하지 않는 최상위 Layer가 포함되어 있습니다.

지원 타입
• Frame
• Instance
• Component
• Group`
    });


    return;
  }


  /* -------------------------------------------------------
     ANALYZE
  ------------------------------------------------------- */

  if (
    msg.type ===
    "analyze"
  ) {

    const results =
      selection.map(root => ({
        name:
          root.name,

        rootType:
          root.type,

        willConvertToFrame:
          root.type !== "FRAME",

        ...analyzeScreen(
          root
        )
      }));


    figma.ui.postMessage({
      type:
        "analysis",

      results
    });


    return;
  }


  /* -------------------------------------------------------
     CLEAN
  ------------------------------------------------------- */

  if (
    msg.type ===
    "clean"
  ) {

    approvedGarbageIds =
      new Set(
        msg.garbageIds || []
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


    try {

      if (
        convertFontToInter
      ) {

        await loadInterStyle(
          "Regular"
        );
      }


      const cleanedRoots =
        [];


      const total = {

        screens:
          selection.length,

        committed:
          0,

        rolledBack:
          0,

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
        const originalRoot of
        selection
      ) {

        const result =
          await cleanWithVisualProtection(
            originalRoot
          );


        cleanedRoots.push(
          result.root
        );


        if (
          result.success
        ) {

          total.committed++;

        } else {

          total.rolledBack++;
        }


        for (
          const key of
          Object.keys(
            result.stats
          )
        ) {

          if (
            key in total
          ) {

            total[key] +=
              result.stats[key];
          }
        }
      }


      figma.currentPage.selection =
        cleanedRoots;


      figma.viewport
        .scrollAndZoomIntoView(
          cleanedRoots
        );


      figma.ui.postMessage({
        type:
          "complete",

        result:
          total
      });


      if (
        total.rolledBack > 0
      ) {

        figma.notify(
          `${total.rolledBack}개 Screen은 화면 차이 감지로 Rollback되었습니다.`
        );

      } else {

        figma.notify(
          "Cleanup 완료 · Visual Verification PASS"
        );
      }


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
  }
};
