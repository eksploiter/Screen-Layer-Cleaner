figma.showUI(__html__, {
  width: 420,
  height: 680,
  themeColors: true
});


/* =========================================================
   Screen Layer Cleaner
   =========================================================

   기능

   1. Garbage 후보 분석
   2. 사용자가 승인한 Garbage만 삭제
   3. Instance Detach
   4. Frame / Group / Auto Layout 제거
   5. 가능한 모든 Layer를 Screen 바로 아래 1 Depth
   6. Mask / Clip / Composite → Visual Bake
   7. Text Font → Inter
   8. Text Layer Name → "-"
   9. Vector / Icon → "icon"
   10. Line → "line"
   11. Rectangle → "shape"
   12. Image Fill → "image"

========================================================= */


/* =========================================================
   Global State
========================================================= */

let approvedGarbageIds = new Set();


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
    node.type === "INSTANCE" ||
    node.type === "SECTION"
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
   Garbage
========================================================= */

function getGarbageReason(node) {

  /*
   * Hidden
   */
  if (
    "visible" in node &&
    node.visible === false
  ) {

    return "Hidden · visible=false";
  }


  /*
   * 완전 투명
   */
  if (
    "opacity" in node &&
    node.opacity === 0
  ) {

    return "Transparent · opacity=0";
  }


  /*
   * Slice
   */
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
   Paint
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
        typeof paint.opacity === "number" &&
        paint.opacity === 0
      ) {

        return false;
      }


      return true;
    }
  );
}


function hasVisibleEffects(node) {

  if (
    !("effects" in node) ||
    !Array.isArray(node.effects)
  ) {

    return false;
  }


  return node.effects.some(
    effect => {

      return (
        effect.visible !== false
      );
    }
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


  return node.fills.some(
    fill => {

      return (
        fill.type === "IMAGE" &&
        fill.visible !== false
      );
    }
  );
}


/* =========================================================
   Mask / Clip Detection
========================================================= */

function containsMask(node) {

  if (!hasChildren(node)) {
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
  if (
    containsMask(node)
  ) {

    return true;
  }


  /*
   * Parent opacity
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
   * Parent effect
   */
  if (
    hasVisibleEffects(node)
  ) {

    return true;
  }


  return false;
}


/* =========================================================
   Inter Font
========================================================= */

/*
   Figma의 일반적인 Inter style 이름.

   시스템/파일 환경에 따라 특정 스타일이 없을 경우
   Regular로 fallback한다.
*/

const INTER_STYLES = [
  "Thin",
  "Thin Italic",

  "Extra Light",
  "Extra Light Italic",

  "Light",
  "Light Italic",

  "Regular",
  "Italic",

  "Medium",
  "Medium Italic",

  "Semi Bold",
  "Semi Bold Italic",

  "Bold",
  "Bold Italic",

  "Extra Bold",
  "Extra Bold Italic",

  "Black",
  "Black Italic"
];


const loadedInterStyles =
  new Set();


/*
   원래 폰트 Style을 보고
   가장 가까운 Inter Style을 선택한다.
*/
function mapFontStyleToInter(
  sourceStyle
) {

  const original =
    String(
      sourceStyle || ""
    );


  const style =
    original
      .toLowerCase()
      .replace(/[_-]/g, " ");


  const italic =
    style.includes("italic") ||
    style.includes("oblique");


  let weight =
    "Regular";


  if (
    style.includes("black") ||
    style.includes("heavy")
  ) {

    weight = "Black";

  } else if (
    style.includes("extra bold") ||
    style.includes("extrabold") ||
    style.includes("ultra bold")
  ) {

    weight = "Extra Bold";

  } else if (
    style.includes("semi bold") ||
    style.includes("semibold") ||
    style.includes("demi bold") ||
    style.includes("demibold")
  ) {

    weight = "Semi Bold";

  } else if (
    style.includes("bold")
  ) {

    weight = "Bold";

  } else if (
    style.includes("medium")
  ) {

    weight = "Medium";

  } else if (
    style.includes("extra light") ||
    style.includes("extralight") ||
    style.includes("ultra light")
  ) {

    weight = "Extra Light";

  } else if (
    style.includes("light")
  ) {

    weight = "Light";

  } else if (
    style.includes("thin")
  ) {

    weight = "Thin";
  }


  if (italic) {

    if (weight === "Regular") {
      return "Italic";
    }

    return `${weight} Italic`;
  }


  return weight;
}


/*
   Inter Font Load
*/
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
      family: "Inter",
      style
    });


    loadedInterStyles.add(
      style
    );


    return style;


  } catch (error) {

    /*
     * 해당 Weight가 없는 경우
     * Regular fallback
     */
    console.warn(
      `Inter ${style} load failed.`,
      error
    );


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


/*
   Text 하나를 Inter로 변환.

   Text 내용, Font Size, Line Height,
   Letter Spacing 등은 건드리지 않는다.
*/
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


  const length =
    node.characters.length;


  /*
   * 빈 Text Layer
   */
  if (
    length === 0
  ) {

    const style =
      await loadInterStyle(
        "Regular"
      );


    try {

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

    /*
     * Mixed Font까지 처리하기 위해
     * styled segment 단위로 읽는다.
     */
    const segments =
      node.getStyledTextSegments([
        "fontName"
      ]);


    let convertedSegments = 0;


    for (
      const segment of segments
    ) {

      let sourceStyle =
        "Regular";


      if (
        segment.fontName &&
        segment.fontName !==
          figma.mixed
      ) {

        sourceStyle =
          segment.fontName.style;
      }


      const requestedStyle =
        mapFontStyleToInter(
          sourceStyle
        );


      const loadedStyle =
        await loadInterStyle(
          requestedStyle
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


        convertedSegments++;

      } catch (error) {

        console.warn(
          "Range font conversion failed:",
          node.name,
          error
        );
      }
    }


    return {
      converted:
        convertedSegments > 0,

      segments:
        convertedSegments
    };


  } catch (error) {

    /*
     * Styled segment API 예외 시
     * 전체 Regular fallback
     */
    console.warn(
      "Styled segment conversion failed:",
      node.name,
      error
    );


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


    } catch (fallbackError) {

      console.warn(
        "Inter fallback failed:",
        node.name,
        fallbackError
      );


      return {
        converted: false,
        segments: 0
      };
    }
  }
}


/* =========================================================
   Rename
========================================================= */

function normalizeLayerName(node) {

  /*
   * Text
   */
  if (
    node.type === "TEXT"
  ) {

    node.name = "-";

    return;
  }


  /*
   * Line
   */
  if (
    node.type === "LINE"
  ) {

    node.name = "line";

    return;
  }


  /*
   * Icon / Vector
   */
  if (
    isIconType(node)
  ) {

    node.name = "icon";

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

      node.name =
        "image";

    } else {

      node.name =
        "shape";
    }
  }
}


/* =========================================================
   Instance Detach
========================================================= */

function detachInstancesRecursive(
  parent,
  stats
) {

  if (
    !hasChildren(parent)
  ) {

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
         * 실패한 Instance는
         * 이후 Bake될 수 있도록 그대로 둔다.
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
   Container Visual
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
   Visual Shell
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


  rect.name =
    "shape";


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

  } catch (error) {

    console.warn(
      "Shell transform failed:",
      error
    );
  }


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

    /*
     * 2배 PNG Export
     */
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
        bounds.height,

      sourceName:
        node.name
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


    rect.name =
      "image";


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
      "Create baked image failed:",
      error
    );


    return null;
  }
}


/* =========================================================
   Build Flatten Plan
========================================================= */

async function buildFlattenPlan(
  root,
  stats
) {

  const plan =
    [];


  async function visit(node) {

    /*
     * Garbage 후보
     */
    if (
      isDefinitelyGarbage(node)
    ) {

      /*
       * 사용자가 체크한 Garbage만 삭제
       */
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
       * 체크하지 않은 Garbage는
       * 구조 정리에서도 제외하고 그대로 보존한다.
       */
      plan.push({
        type:
          "preserve",

        node,

        garbageProtected:
          true
      });


      stats.protectedGarbage++;


      return;
    }


    /*
     * Container
     */
    if (
      isContainer(node)
    ) {

      /*
       * Mask / Clip / Composite
       */
      if (
        needsBake(node)
      ) {

        const baked =
          await createBakeSnapshot(
            node
          );


        if (baked) {

          plan.push({
            type:
              "bake",

            source:
              node,

            snapshot:
              baked
          });


          stats.bakedAreas++;


          return;
        }


        /*
         * Export 실패 시
         * 화면 보호를 위해 그대로 보존
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
       * Container 자체의 Background
       */
      if (
        hasOwnVisual(node)
      ) {

        plan.push({
          type:
            "shell",

          source:
            node,

          snapshot:
            snapshotContainerVisual(
              node
            )
        });
      }


      /*
       * Child
       */
      if (
        hasChildren(node)
      ) {

        const children =
          [...node.children];


        for (
          const child of children
        ) {

          await visit(child);
        }
      }


      return;
    }


    /*
     * Mask 자체가 예상치 못하게
     * Leaf로 도달했을 경우
     */
    if (
      "isMask" in node &&
      node.isMask === true
    ) {

      const baked =
        await createBakeSnapshot(
          node
        );


      if (baked) {

        plan.push({
          type:
            "bake",

          source:
            node,

          snapshot:
            baked
        });


        stats.bakedAreas++;

      } else {

        plan.push({
          type:
            "preserve",

          node
        });


        stats.preservedAreas++;
      }


      return;
    }


    /*
     * Normal leaf
     */
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

    await visit(child);
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
      item.type !==
      "garbage"
    ) {

      continue;
    }


    try {

      item.node.remove();

      stats.removedGarbage++;

    } catch (error) {

      console.warn(
        "Garbage delete failed:",
        error
      );
    }
  }


  /*
   * 결과 구성
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


    /* --------------------------------
       Shell
    -------------------------------- */

    if (
      item.type ===
      "shell"
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


    /* --------------------------------
       Bake
    -------------------------------- */

    if (
      item.type ===
      "bake"
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


    /* --------------------------------
       Preserve
    -------------------------------- */

    if (
      item.type ===
      "preserve"
    ) {

      try {

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

      } catch (error) {

        console.warn(
          "Preserve failed:",
          error
        );
      }


      continue;
    }


    /* --------------------------------
       Leaf
    -------------------------------- */

    if (
      item.type ===
      "leaf"
    ) {

      const node =
        item.node;


      try {

        /*
         * Parent 변경
         */
        root.appendChild(
          node
        );


        /*
         * 화면 위치 복원
         */
        node.relativeTransform =
          absoluteToRelative(
            item.absoluteTransform,
            root
          );


        /*
         * TEXT라면 Inter 변환
         */
        if (
          node.type ===
          "TEXT"
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
         * 이름 정규화
         */
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
   * 원래 Container 제거
   */
  for (
    const child of originalChildren
  ) {

    try {

      /*
       * Root 아래에 여전히 존재하면서
       * Preserve 대상이라면 삭제 금지
       */
      const preserved =
        plan.some(
          item => {

            return (
              item.type ===
                "preserve" &&
              item.node ===
                child
            );
          }
        );


      if (preserved) {
        continue;
      }


      /*
       * 직접 Leaf였던 경우 역시 삭제 금지
       */
      const leaf =
        plan.some(
          item => {

            return (
              item.type ===
                "leaf" &&
              item.node ===
                child
            );
          }
        );


      if (leaf) {
        continue;
      }


      if (
        isContainer(child)
      ) {

        child.remove();

        stats.removedContainers++;
      }


    } catch (_) {}
  }
}


/* =========================================================
   Root
========================================================= */

function prepareRoot(root) {

  /*
   * 선택한 Screen 자체는 유지한다.
   *
   * Root가 Auto Layout이면
   * Layout만 제거한다.
   */
  if (
    "layoutMode" in root &&
    root.layoutMode !==
      "NONE"
  ) {

    try {

      root.layoutMode =
        "NONE";

    } catch (_) {}
  }


  /*
   * Root clipsContent는 유지한다.
   *
   * Screen 밖의 Content가 노출되는 것을
   * 방지하기 위해서다.
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


    /*
     * Instance
     */
    if (
      node.type ===
      "INSTANCE"
    ) {

      result.instances++;
    }


    /*
     * Auto Layout
     */
    if (
      "layoutMode" in node &&
      node.layoutMode !==
        "NONE"
    ) {

      result.autoLayouts++;
    }


    /*
     * Mask
     */
    if (
      "isMask" in node &&
      node.isMask === true
    ) {

      result.masks++;
    }


    /*
     * Clip Content
     */
    if (
      node !== root &&
      "clipsContent" in node &&
      node.clipsContent === true
    ) {

      result.clips++;
    }


    /*
     * Text
     */
    if (
      node.type ===
      "TEXT"
    ) {

      result.text++;


      /*
       * Font가 전부 Inter인지 분석
       */
      try {

        const segments =
          node.getStyledTextSegments([
            "fontName"
          ]);


        const hasNonInter =
          segments.some(
            segment => {

              if (
                !segment.fontName ||
                segment.fontName ===
                  figma.mixed
              ) {

                return true;
              }


              return (
                segment.fontName.family !==
                "Inter"
              );
            }
          );


        if (
          hasNonInter
        ) {

          result.nonInterText++;
        }

      } catch (_) {

        result.nonInterText++;
      }
    }


    /*
     * Icon
     */
    if (
      isIconType(node)
    ) {

      result.icons++;
    }


    /*
     * Line
     */
    if (
      node.type ===
      "LINE"
    ) {

      result.lines++;
    }


    /*
     * Child
     */
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
   Clean
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
   * 1.
   * Instance Detach
   */
  detachInstancesRecursive(
    root,
    stats
  );


  /*
   * 2.
   * 구조 변경 전에 Plan 작성
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
  prepareRoot(
    root
  );


  /*
   * 4.
   * Plan 실행
   */
  await executeFlattenPlan(
    root,
    plan,
    stats
  );


  return stats;
}


/* =========================================================
   UI Message
========================================================= */

figma.ui.onmessage =
async (msg) => {


  /* =====================================================
     Close
  ===================================================== */

  if (
    msg.type ===
    "close"
  ) {

    figma.closePlugin();

    return;
  }


  /* =====================================================
     Select Layer
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


      if (!node) {
        return;
      }


      if (
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
     Selection Validation
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
        "정리할 Screen Frame을 선택해주세요."
    });


    return;
  }


  const roots =
    selection.filter(
      node => {

        return (
          node.type ===
            "FRAME" ||
          node.type ===
            "COMPONENT"
        );
      }
    );


  if (
    roots.length !==
    selection.length
  ) {

    figma.ui.postMessage({

      type:
        "error",

      message:
        "최상위 Screen Frame 또는 Component만 선택해주세요."
    });


    return;
  }


  /* =====================================================
     Analyze
  ===================================================== */

  if (
    msg.type ===
    "analyze"
  ) {

    const results =
      roots.map(
        root => {

          return {

            name:
              root.name,

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
     Clean
  ===================================================== */

  if (
    msg.type ===
    "clean"
  ) {

    approvedGarbageIds =
      new Set(
        msg.garbageIds || []
      );


    figma.ui.postMessage({

      type:
        "processing"
    });


    const total = {

      screens:
        roots.length,

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


    try {

      /*
       * Inter Regular을 우선 Load
       */
      await loadInterStyle(
        "Regular"
      );


      for (
        const root of roots
      ) {

        const result =
          await cleanScreen(
            root
          );


        for (
          const key of Object.keys(
            result
          )
        ) {

          if (
            key in total
          ) {

            total[key] +=
              result[key];
          }
        }
      }


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
        `Cleanup 완료 · Text ${total.convertedTexts}개 Inter 변환`
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
