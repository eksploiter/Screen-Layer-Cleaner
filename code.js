figma.showUI(__html__, {
  width: 440,
  height: 760,
  themeColors: true
});


/* =========================================================
   SCREEN LAYER CLEANER

   CORE RULE
   ---------------------------------------------------------
   1. 디자인 화면은 절대 변하면 안 된다.
   2. 원본에는 직접 작업하지 않는다.
   3. Working Copy는 반드시 PAGE 바로 아래에서 작업한다.
   4. 내부 Instance는 가능한 한 전부 Detach한다.
   5. Cleanup 후 Before / After PNG가 동일할 때만 Commit.
   6. 다르면 Working Copy 삭제 + 원본 유지.

========================================================= */


/* =========================================================
   GLOBAL STATE
========================================================= */

let approvedGarbageIds = new Set();

let renameTextToHyphen = false;

let convertFontToInter = false;

const ROW_TOLERANCE = 6;

const MAX_DETACH_ROUNDS = 100;


/* =========================================================
   TRANSFORM UTILITIES
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

  const invDet =
    1 / det;

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


function isInsideInstance(node) {
  let current =
    node.parent;

  while (current) {
    if (
      current.type === "INSTANCE"
    ) {
      return true;
    }

    current =
      current.parent;
  }

  return false;
}


/* =========================================================
   PAINT HELPERS
========================================================= */

function hasVisiblePaint(paints) {
  if (!Array.isArray(paints)) {
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
  if (
    !hasChildren(node)
  ) {
    return false;
  }

  for (
    const child of node.children
  ) {

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


function actuallyClipsChildren(node) {
  if (
    !("clipsContent" in node) ||
    node.clipsContent !== true
  ) {
    return false;
  }


  if (
    !hasChildren(node)
  ) {
    return false;
  }


  const parentBounds =
    node.absoluteBoundingBox;


  if (
    !parentBounds
  ) {
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
    const child of node.children
  ) {

    if (
      "visible" in child &&
      child.visible === false
    ) {
      continue;
    }


    const bounds =
      child.absoluteRenderBounds ||
      child.absoluteBoundingBox;


    if (
      !bounds
    ) {
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


function needsBake(node) {
  if (
    !isContainer(node)
  ) {
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


/*
 * IMPORTANT:
 * 이 함수는 source가 Instance 안쪽에 있으면
 * insertChild에서 실패할 수 있다.
 *
 * 따라서 Working Copy를 PAGE 아래에 둔 뒤에만 사용.
 */
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
      "Root Parent를 찾을 수 없습니다."
    );
  }


  if (
    isInsideInstance(parent)
  ) {
    throw new Error(
      "Frame 변환 대상의 Parent가 Instance 내부입니다."
    );
  }


  const index =
    parent.children.indexOf(
      source
    );


  const sourceName =
    source.name;


  const width =
    source.width;


  const height =
    source.height;


  const absoluteTransform =
    source.absoluteTransform;


  const children =
    [];


  if (
    hasChildren(source)
  ) {

    for (
      const child of
      [...source.children]
    ) {

      children.push({
        node:
          child,

        absoluteTransform:
          child.absoluteTransform
      });
    }
  }


  const frame =
    figma.createFrame();


  frame.name =
    sourceName;


  frame.fills =
    [];


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


  try {
    frame.layoutMode =
      "NONE";
  } catch (_) {}


  if (
    source.type !==
    "GROUP"
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
   * 이미 FRAME
   */
  if (
    node.type ===
    "FRAME"
  ) {
    return node;
  }


  /*
   * INSTANCE
   */
  if (
    node.type ===
    "INSTANCE"
  ) {

    try {

      const detached =
        node.detachInstance();


      if (
        detached.type ===
        "FRAME"
      ) {
        return detached;
      }


      return replaceContainerWithFrame(
        detached
      );


    } catch (error) {

      console.warn(
        "Root instance detach failed:",
        error
      );


      return replaceContainerWithFrame(
        node
      );
    }
  }


  /*
   * COMPONENT / GROUP
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
   INSTANCE DETACH
========================================================= */

/*
 * 모든 Instance를 수집.
 *
 * depth 포함해서 deepest-first 처리 가능하게 함.
 */
function collectInstances(root) {

  const instances =
    [];


  function walk(
    node,
    depth
  ) {

    if (
      node.type ===
      "INSTANCE"
    ) {

      instances.push({
        node,
        depth
      });
    }


    if (
      hasChildren(node)
    ) {

      for (
        const child of node.children
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


  return instances;
}


/*
 * Instance가 없어질 때까지 반복 Detach.
 *
 * 깊은 Instance부터 Detach한다.
 */
function detachAllInstances(
  root,
  stats
) {

  for (
    let round = 0;
    round < MAX_DETACH_ROUNDS;
    round++
  ) {

    const instances =
      collectInstances(
        root
      );


    if (
      instances.length === 0
    ) {
      return;
    }


    /*
     * deepest first
     */
    instances.sort(
      (a, b) =>
        b.depth - a.depth
    );


    let detachedThisRound =
      0;


    for (
      const item of instances
    ) {

      const instance =
        item.node;


      try {

        /*
         * 이미 detach 과정에서 삭제/변경된 reference라면 skip
         */
        if (
          !instance.parent
        ) {
          continue;
        }


        instance.detachInstance();


        stats.detachedInstances++;

        detachedThisRound++;


      } catch (error) {

        console.warn(
          "Nested instance detach failed:",
          instance.name,
          error
        );
      }
    }


    /*
     * 더 이상 아무 것도 detach 못 하면 종료.
     */
    if (
      detachedThisRound === 0
    ) {
      return;
    }
  }


  console.warn(
    "Instance detach reached maximum rounds."
  );
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
      .replace(
        /[_-]/g,
        " "
      );


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
      weight ===
      "Regular"
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
    node.type !==
    "TEXT"
  ) {

    return {
      converted:
        false,

      segments:
        0
    };
  }


  if (
    node.characters.length ===
    0
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
        converted:
          true,

        segments:
          1
      };


    } catch (_) {

      return {
        converted:
          false,

        segments:
          0
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
        segment.fontName !==
          figma.mixed
          ? segment.fontName.style
          : "Regular";


      const targetStyle =
        mapFontStyleToInter(
          sourceStyle
        );


      const loadedStyle =
        await loadInterStyle(
          targetStyle
        );


      node.setRangeFontName(
        segment.start,
        segment.end,
        {
          family:
            "Inter",

          style:
            loadedStyle
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


  } catch (error) {

    console.warn(
      "Font conversion failed:",
      node.name,
      error
    );


    return {
      converted:
        false,

      segments:
        0
    };
  }
}


/* =========================================================
   SCREENSHOT / NAMING
========================================================= */

function isScreenshotLayer(
  node,
  root
) {

  if (
    node.type !==
      "RECTANGLE" ||
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
    node.type ===
    "TEXT"
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
    node.type ===
    "LINE"
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
    node.type ===
    "RECTANGLE"
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
    if (
      snapshot.strokeWeight !== null
    ) {

      rect.strokeWeight =
        snapshot.strokeWeight;
    }
  } catch (_) {}


  try {
    if (
      snapshot.strokeAlign !== null
    ) {

      rect.strokeAlign =
        snapshot.strokeAlign;
    }
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
   BAKE
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

      /*
       * 남아있는 Instance가 있다면
       * 직접 child를 꺼내지 않는다.
       *
       * Instance 조작 에러를 막기 위해
       * 해당 영역은 Bake fallback.
       */
      if (
        node.type ===
        "INSTANCE"
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


        plan.push({
          type:
            "preserve",

          node
        });


        stats.preservedAreas++;


        return;
      }


      /*
       * Mask / Real Clip / Composite
       */
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


        plan.push({
          type:
            "preserve",

          node
        });


        stats.preservedAreas++;


        return;
      }


      /*
       * Container 자체 Visual
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
   EXECUTE FLATTEN PLAN
========================================================= */

async function executeFlattenPlan(
  root,
  plan,
  stats
) {

  const originalChildren =
    [...root.children];


  /*
   * GARBAGE DELETE
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
   * RESULT BUILD
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

      try {

        /*
         * 이미 root child라면 이동 불필요.
         */
        if (
          item.node.parent !==
          root
        ) {

          /*
           * Instance 내부 노드는 절대 직접 이동하지 않는다.
           */
          if (
            isInsideInstance(
              item.node
            )
          ) {

            console.warn(
              "Preserve skipped because node is inside Instance:",
              item.node.name
            );


            stats.preservedAreas++;


            continue;
          }


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
        }


        stats.finalLayers++;


      } catch (error) {

        console.warn(
          "Preserve move failed:",
          item.node.name,
          error
        );


        stats.preservedAreas++;
      }


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


      if (
        !node ||
        !node.parent
      ) {
        continue;
      }


      /*
       * Safety:
       * Instance 내부에 남아있는 leaf는
       * 직접 이동하지 않는다.
       */
      if (
        isInsideInstance(
          node
        )
      ) {

        console.warn(
          "Leaf still inside Instance. Skipped:",
          node.name
        );


        stats.preservedAreas++;


        continue;
      }


      try {

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
         * FONT
         */
        if (
          node.type ===
            "TEXT" &&
          convertFontToInter
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


        stats.preservedAreas++;
      }
    }
  }


  /*
   * UNUSED ORIGINAL CONTAINER REMOVE
   */
  for (
    const child of
    originalChildren
  ) {

    if (
      !child ||
      !child.parent
    ) {
      continue;
    }


    const preserved =
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
   SAFE SORTING
========================================================= */

function getBounds(node) {
  const bounds =
    node.absoluteBoundingBox;


  if (
    !bounds
  ) {
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
  if (
    !a ||
    !b
  ) {
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
   * SAME ROW → LEFT TO RIGHT
   */
  if (
    Math.abs(
      a.bounds.y -
      b.bounds.y
    ) <= ROW_TOLERANCE
  ) {

    const xDiff =
      a.bounds.x -
      b.bounds.x;


    if (
      Math.abs(
        xDiff
      ) > 0.1
    ) {

      return xDiff;
    }
  }


  /*
   * TOP → BOTTOM
   */
  const yDiff =
    a.bounds.y -
    b.bounds.y;


  if (
    Math.abs(
      yDiff
    ) > 0.1
  ) {

    return yDiff;
  }


  return (
    a.originalPanelIndex -
    b.originalPanelIndex
  );
}


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
   * Figma Layer panel은
   * children array의 reverse 순서로 보인다.
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
   * 겹치는 Layer는
   * 기존 Panel 순서 유지 constraint.
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
        next.indegree ===
        0
      ) {

        available.push(
          next
        );
      }
    }
  }


  /*
   * Cycle 등 예외라면
   * 순서 변경하지 않음.
   */
  if (
    sorted.length !==
    items.length
  ) {

    console.warn(
      "Safe sorting aborted."
    );


    return;
  }


  const finalChildren =
    sorted
      .map(
        item =>
          item.node
      )
      .reverse();


  for (
    let i = 0;
    i < finalChildren.length;
    i++
  ) {

    try {

      root.insertChild(
        i,
        finalChildren[i]
      );

    } catch (error) {

      console.warn(
        "Layer reorder failed:",
        finalChildren[i].name,
        error
      );
    }
  }
}


/* =========================================================
   PREPARE ROOT
========================================================= */

function prepareRoot(root) {

  try {

    if (
      root.layoutMode !==
      "NONE"
    ) {

      root.layoutMode =
        "NONE";
    }

  } catch (_) {}
}


/* =========================================================
   VISUAL VERIFICATION
========================================================= */

async function exportVisual(
  node
) {

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
   ANALYSIS
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
     * GARBAGE
     */
    const reason =
      getGarbageReason(
        node
      );


    if (
      reason
    ) {

      result.garbage++;


      result.garbageItems.push({
        id:
          node.id,

        name:
          node.name,

        type:
          node.type,

        reason,

        path:
          currentPath
      });
    }


    /*
     * CONTAINER
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


    /*
     * INSTANCE
     */
    if (
      node.type ===
      "INSTANCE"
    ) {

      result.instances++;
    }


    /*
     * AUTO LAYOUT
     */
    if (
      "layoutMode" in node &&
      node.layoutMode !==
        "NONE"
    ) {

      result.autoLayouts++;
    }


    /*
     * MASK
     */
    if (
      "isMask" in node &&
      node.isMask === true
    ) {

      result.masks++;
    }


    /*
     * REAL CLIP
     */
    if (
      node !== root &&
      actuallyClipsChildren(
        node
      )
    ) {

      result.clips++;
    }


    /*
     * TEXT
     */
    if (
      node.type ===
      "TEXT"
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
              segment.fontName ===
                figma.mixed ||
              segment.fontName.family !==
                "Inter"
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


    /*
     * ICON
     */
    if (
      isIconType(node)
    ) {

      result.icons++;
    }


    /*
     * LINE
     */
    if (
      node.type ===
      "LINE"
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
   CLEAN WORKING ROOT
========================================================= */

async function cleanWorkingRoot(
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
   * 1.
   * 모든 nested Instance 가능한 만큼 해제.
   */
  detachAllInstances(
    root,
    stats
  );


  /*
   * 2.
   * detach 후 남은 Instance 수 로그.
   */
  const remainingInstances =
    collectInstances(root);


  if (
    remainingInstances.length > 0
  ) {

    console.warn(
      `Remaining instances: ${remainingInstances.length}`
    );
  }


  /*
   * 3.
   * 현재 구조 기준 Flatten Plan.
   */
  const plan =
    await buildFlattenPlan(
      root,
      stats
    );


  /*
   * 4.
   * Root Auto Layout 제거.
   */
  prepareRoot(
    root
  );


  /*
   * 5.
   * Flatten.
   */
  await executeFlattenPlan(
    root,
    plan,
    stats
  );


  /*
   * 6.
   * 안전한 Layer sorting.
   */
  sortLayersSafely(
    root
  );


  return stats;
}


/* =========================================================
   PAGE-LEVEL WORKING COPY
========================================================= */

/*
 * 이번 수정의 핵심.
 *
 * Working Copy는 원래 Parent가 아니라
 * 반드시 figma.currentPage 바로 아래에 둔다.
 *
 * 따라서 Instance ancestry가 완전히 끊어진다.
 */
function createPageLevelWorkingCopy(
  originalRoot
) {

  const working =
    originalRoot.clone();


  /*
   * original의 absolute position 저장.
   */
  const bounds =
    originalRoot.absoluteBoundingBox;


  const originalTransform =
    originalRoot.absoluteTransform;


  /*
   * PAGE 바로 아래로 이동.
   */
  figma.currentPage.appendChild(
    working
  );


  /*
   * 기존 화면과 겹치면 작업 중 보일 수 있으므로
   * 아주 멀리 떨어진 위치로 이동.
   *
   * Visual Export는 Node 자체 기준이므로
   * 화면상 위치가 달라도 상관없다.
   */
  if (
    bounds
  ) {

    working.x =
      bounds.x + 100000;

    working.y =
      bounds.y + 100000;

  } else {

    working.x =
      100000;

    working.y =
      100000;
  }


  return {
    working,
    originalTransform
  };
}


/* =========================================================
   COMMIT CLEAN ROOT
========================================================= */

function commitWorkingRoot(
  originalRoot,
  workingRoot
) {

  const originalParent =
    originalRoot.parent;


  if (
    !originalParent ||
    !("children" in originalParent)
  ) {

    throw new Error(
      "Original Parent를 찾을 수 없습니다."
    );
  }


  const originalIndex =
    originalParent.children.indexOf(
      originalRoot
    );


  const originalAbsoluteTransform =
    originalRoot.absoluteTransform;


  /*
   * 원본 Parent가 Instance 또는 Instance 내부라면
   * clean 결과를 같은 곳에 insert할 수 없다.
   *
   * 이 경우 Visual 보호 원칙상
   * 기존 구조를 건드리지 않고 Rollback 처리해야 한다.
   */
  if (
    originalParent.type ===
      "INSTANCE" ||
    isInsideInstance(
      originalParent
    )
  ) {

    throw new Error(
      "원본 Screen 자체가 다른 Instance 내부에 있어 Clean 결과를 같은 위치에 Commit할 수 없습니다."
    );
  }


  /*
   * 원래 위치에 clean root 삽입.
   */
  originalParent.insertChild(
    Math.max(
      originalIndex,
      0
    ),
    workingRoot
  );


  /*
   * Absolute 위치 복원.
   */
  workingRoot.relativeTransform =
    absoluteToRelative(
      originalAbsoluteTransform,
      originalParent
    );


  /*
   * Original 제거.
   */
  originalRoot.remove();


  return workingRoot;
}


/* =========================================================
   TRANSACTIONAL CLEAN
========================================================= */

async function cleanWithVisualProtection(
  originalRoot
) {

  /*
   * =============================================
   * BEFORE
   * =============================================
   */
  const beforeVisual =
    await exportVisual(
      originalRoot
    );


  /*
   * =============================================
   * WORKING COPY
   * =============================================
   */
  const workingResult =
    createPageLevelWorkingCopy(
      originalRoot
    );


  let working =
    workingResult.working;


  try {

    /*
     * Page-level이므로 Instance ancestry가 없어야 함.
     */
    if (
      isInsideInstance(
        working
      )
    ) {

      throw new Error(
        "Working Copy가 여전히 Instance 내부에 있습니다."
      );
    }


    /*
     * Root를 Frame으로 정규화.
     */
    working =
      normalizeRootToFrame(
        working
      );


    /*
     * Cleanup.
     */
    const stats =
      await cleanWorkingRoot(
        working
      );


    /*
     * =============================================
     * AFTER
     * =============================================
     */
    const afterVisual =
      await exportVisual(
        working
      );


    /*
     * =============================================
     * VERIFY
     * =============================================
     */
    const visualMatch =
      byteArraysEqual(
        beforeVisual,
        afterVisual
      );


    /*
     * FAIL
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
          false,

        reason:
          "Visual mismatch"
      };
    }


    /*
     * =============================================
     * COMMIT
     * =============================================
     */
    try {

      const committed =
        commitWorkingRoot(
          originalRoot,
          working
        );


      return {
        success:
          true,

        root:
          committed,

        stats,

        visualMatch:
          true,

        reason:
          null
      };


    } catch (commitError) {

      /*
       * Commit 실패 시
       * Working Copy 삭제.
       *
       * Original은 아직 살아 있음.
       */
      try {
        working.remove();
      } catch (_) {}


      console.warn(
        "Commit failed:",
        commitError
      );


      return {
        success:
          false,

        root:
          originalRoot,

        stats,

        visualMatch:
          true,

        reason:
          commitError.message
      };
    }


  } catch (error) {

    /*
     * Cleanup 도중 실패해도
     * 원본은 그대로.
     */
    try {

      if (
        working &&
        working.parent
      ) {

        working.remove();
      }

    } catch (_) {}


    throw error;
  }
}


/* =========================================================
   UI MESSAGE HANDLER
========================================================= */

figma.ui.onmessage =
async msg => {


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
    [...figma.currentPage.selection];


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
`지원하지 않는 최상위 Layer가 포함되어 있습니다.

지원 타입
• Frame
• Instance
• Component
• Group`
    });


    return;
  }


  /* =====================================================
     ANALYZE
  ===================================================== */

  if (
    msg.type ===
    "analyze"
  ) {

    const results =
      selection.map(
        root => ({
          name:
            root.name,

          rootType:
            root.type,

          willConvertToFrame:
            root.type !==
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


    try {

      if (
        convertFontToInter
      ) {

        await loadInterStyle(
          "Regular"
        );
      }


      const resultRoots =
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


        resultRoots.push(
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


        if (
          !result.success &&
          result.reason
        ) {

          console.warn(
            `Rollback reason: ${result.reason}`
          );
        }
      }


      figma.currentPage.selection =
        resultRoots;


      figma.viewport
        .scrollAndZoomIntoView(
          resultRoots
        );


      figma.ui.postMessage({
        type:
          "complete",

        result:
          total
      });


      if (
        total.rolledBack >
        0
      ) {

        figma.notify(
          `${total.rolledBack}개 Screen은 Visual 보호를 위해 Rollback되었습니다.`
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
