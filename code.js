figma.showUI(__html__, {
  width: 440,
  height: 760,
  themeColors: true
});


/* =========================================================
   SCREEN LAYER CLEANER - STABLE VERSION

   제1원칙
   ---------------------------------------------------------
   디자인 화면 보존 > 1 Depth > Layer 정리

   이번 안정 버전에서 제거한 것
   ---------------------------------------------------------
   - Working Clone
   - 100000px 복사본
   - PNG Before / After 비교
   - Visual Verification용 Export
   - 자동 Rollback
   - TEMP Node 전체 탐색
   - Instance 무한 반복 Detach
   - Mask / Clip 무조건 Screenshot화

   처리 원칙
   ---------------------------------------------------------
   1. 선택한 Screen 자체에서 직접 작업
   2. Root가 Instance면 Detach
   3. Root가 Component / Group이면 Frame으로 변환
   4. 내부 Instance는 가능한 것만 1회 재귀 Detach
   5. 안전한 Container만 Flatten
   6. 위험한 Container는 내부 구조 그대로 보존
   7. 개별 Layer 오류는 Skip
   8. 화면 전체 작업을 중단시키지 않음
========================================================= */


/* =========================================================
   GLOBAL
========================================================= */

let renameTextToHyphen = false;
let convertFontToInter = false;

let approvedGarbageIds =
  new Set();

const ROW_TOLERANCE = 6;


/* =========================================================
   STATS
========================================================= */

function createStats() {
  return {
    detachedInstances: 0,

    removedGarbage: 0,
    protectedGarbage: 0,

    removedContainers: 0,
    movedLayers: 0,

    visualShells: 0,

    /*
     * 현재 안정 버전에서는
     * screenshot fallback을 거의 사용하지 않는다.
     *
     * UI 호환을 위해 값은 유지.
     */
    bakedAreas: 0,

    preservedAreas: 0,

    convertedTexts: 0,
    convertedFontSegments: 0,
    failedFontConversions: 0,

    finalLayers: 0
  };
}


/* =========================================================
   SAFE NODE ACCESS
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


function safeAbsoluteTransform(node) {
  try {
    return node.absoluteTransform;
  } catch (_) {
    return null;
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


function safeRemove(node) {
  if (!isAlive(node)) {
    return false;
  }

  try {
    node.remove();
    return true;
  } catch (error) {
    console.warn(
      "Remove skipped:",
      safeName(node),
      error
    );

    return false;
  }
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
    safeAbsoluteTransform(
      parent
    );


  if (!parentTransform) {
    throw new Error(
      "Parent Transform을 읽을 수 없습니다."
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
   BASIC HELPERS
========================================================= */

function hasChildren(node) {
  if (!isAlive(node)) {
    return false;
  }


  try {
    return (
      "children" in node &&
      node.children != null
    );
  } catch (_) {
    return false;
  }
}


function childrenOf(node) {
  if (!hasChildren(node)) {
    return [];
  }


  try {
    return [
      ...node.children
    ];
  } catch (_) {
    return [];
  }
}


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
  const type =
    safeType(node);


  return (
    type === "FRAME" ||
    type === "GROUP" ||
    type === "COMPONENT" ||
    type === "INSTANCE"
  );
}


function isInsideInstance(node) {
  let current =
    safeParent(node);


  while (current) {
    if (
      safeType(current) ===
      "INSTANCE"
    ) {
      return true;
    }


    current =
      safeParent(current);
  }


  return false;
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


function hasImageFill(node) {
  if (!isAlive(node)) {
    return false;
  }


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


function hasVisibleEffects(node) {
  if (!isAlive(node)) {
    return false;
  }


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
      return "Hidden · visible=false";
    }
  } catch (_) {}


  try {
    if (
      "opacity" in node &&
      node.opacity === 0
    ) {
      return "Transparent · opacity=0";
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


/* =========================================================
   FONT
========================================================= */

/*
 * 이동 직전에 필요한 폰트만 Load한다.
 *
 * 이전처럼 화면 전체 폰트를 사전 Load하지 않는다.
 * → 속도 개선.
 */

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


    loadedFonts.add(
      key
    );


    return true;

  } catch (error) {
    console.warn(
      "Font load skipped:",
      fontName.family,
      fontName.style,
      error
    );


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
        segment.fontName ===
          figma.mixed
      ) {
        continue;
      }


      const loaded =
        await loadFontOnce(
          segment.fontName
        );


      if (!loaded) {
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


/* =========================================================
   INTER
========================================================= */

const loadedInterStyles =
  new Set();


function mapFontStyleToInter(
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
    style = "Black";

  } else if (
    value.includes("extra bold") ||
    value.includes("extrabold")
  ) {
    style = "Extra Bold";

  } else if (
    value.includes("semi bold") ||
    value.includes("semibold") ||
    value.includes("demi bold")
  ) {
    style = "Semi Bold";

  } else if (
    value.includes("bold")
  ) {
    style = "Bold";

  } else if (
    value.includes("medium")
  ) {
    style = "Medium";

  } else if (
    value.includes("extra light") ||
    value.includes("extralight")
  ) {
    style = "Extra Light";

  } else if (
    value.includes("light")
  ) {
    style = "Light";

  } else if (
    value.includes("thin")
  ) {
    style = "Thin";
  }


  if (italic) {
    return style === "Regular"
      ? "Italic"
      : `${style} Italic`;
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


async function convertTextToInter(node) {
  if (
    safeType(node) !==
    "TEXT"
  ) {
    return 0;
  }


  /*
   * 기존 Font를 먼저 Load.
   */
  const currentLoaded =
    await ensureTextFontsLoaded(
      node
    );


  if (!currentLoaded) {
    return 0;
  }


  try {
    const segments =
      node.getStyledTextSegments(
        ["fontName"]
      );


    let converted = 0;


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
        await loadInterStyle(
          mapFontStyleToInter(
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

  } catch (error) {
    console.warn(
      "Inter conversion skipped:",
      safeName(node),
      error
    );


    return 0;
  }
}


/* =========================================================
   MASK / CLIP DETECTION
========================================================= */

function containsMask(node) {
  for (
    const child of
    childrenOf(node)
  ) {
    if (!isAlive(child)) {
      continue;
    }


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
    /*
     * 판단 불가능하면 안전하게 Preserve.
     */
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
    if (!isAlive(child)) {
      continue;
    }


    try {
      if (
        "visible" in child &&
        child.visible === false
      ) {
        continue;
      }
    } catch (_) {}


    const bounds =
      safeRenderBounds(
        child
      );


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
   SAFE / UNSAFE CONTAINER
========================================================= */

/*
 * TRUE면 해당 Container는
 * 절대 내부를 풀지 않는다.
 *
 * Container 자체만 Root 1 Depth로 이동.
 */
function shouldPreserveContainer(node) {
  if (!isContainer(node)) {
    return false;
  }


  /*
   * detach 실패한 Instance.
   */
  if (
    safeType(node) ===
    "INSTANCE"
  ) {
    return true;
  }


  /*
   * Mask.
   */
  if (
    containsMask(node)
  ) {
    return true;
  }


  /*
   * 실제 Clip.
   */
  if (
    actuallyClipsChildren(
      node
    )
  ) {
    return true;
  }


  /*
   * Container Opacity.
   */
  try {
    if (
      "opacity" in node &&
      node.opacity !== 1
    ) {
      return true;
    }
  } catch (_) {}


  /*
   * Blend Mode.
   */
  try {
    if (
      "blendMode" in node &&
      node.blendMode !==
        "PASS_THROUGH" &&
      node.blendMode !==
        "NORMAL"
    ) {
      return true;
    }
  } catch (_) {}


  /*
   * Shadow / Blur 등.
   */
  if (
    hasVisibleEffects(node)
  ) {
    return true;
  }


  return false;
}


/* =========================================================
   INSTANCE DETACH
========================================================= */

/*
 * 이전처럼 전체 Instance를 계속 검색하지 않는다.
 *
 * 한 번 재귀 순회하면서
 * 가능한 Instance만 Detach.
 *
 * 실패 → 그대로 유지
 * → shouldPreserveContainer에서 보호.
 */
function detachInstancesSafely(
  parent,
  stats
) {
  const children =
    childrenOf(parent);


  for (
    const originalChild of children
  ) {
    if (!isAlive(originalChild)) {
      continue;
    }


    let child =
      originalChild;


    if (
      safeType(child) ===
      "INSTANCE"
    ) {
      try {
        const detached =
          child.detachInstance();


        if (
          detached &&
          isAlive(detached)
        ) {
          child =
            detached;

          stats.detachedInstances++;
        }

      } catch (error) {
        /*
         * 실패하면 그냥 Instance 유지.
         */
        console.warn(
          "Instance preserved:",
          safeName(child),
          error
        );


        continue;
      }
    }


    if (
      isAlive(child) &&
      hasChildren(child)
    ) {
      detachInstancesSafely(
        child,
        stats
      );
    }
  }
}


/* =========================================================
   ROOT NORMALIZATION
========================================================= */

function copyValue(
  source,
  target,
  key
) {
  try {
    if (
      key in source &&
      key in target &&
      source[key] !==
        figma.mixed
    ) {
      target[key] =
        source[key];
    }
  } catch (_) {}
}


function copyRootAppearance(
  source,
  frame
) {
  copyValue(
    source,
    frame,
    "fills"
  );


  copyValue(
    source,
    frame,
    "strokes"
  );


  copyValue(
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
 * Component / Group → Frame.
 *
 * 이 함수는 선택 Screen 자체에만 사용한다.
 */
function convertRootToFrame(source) {
  if (!isAlive(source)) {
    return null;
  }


  const parent =
    safeParent(source);


  if (
    !parent ||
    !("children" in parent)
  ) {
    return null;
  }


  /*
   * Instance 내부 Root를 억지로 변환하지 않는다.
   */
  if (
    safeType(parent) ===
      "INSTANCE" ||
    isInsideInstance(parent)
  ) {
    return null;
  }


  const sourceTransform =
    safeAbsoluteTransform(
      source
    );


  if (!sourceTransform) {
    return null;
  }


  let width = 1;
  let height = 1;


  try {
    width =
      source.width;

    height =
      source.height;
  } catch (_) {}


  let index = 0;


  try {
    index =
      parent.children.indexOf(
        source
      );
  } catch (_) {}


  /*
   * Child의 absolute position 저장.
   */
  const childSnapshots =
    childrenOf(source)
      .map(
        child => ({
          node:
            child,

          transform:
            safeAbsoluteTransform(
              child
            )
        })
      )
      .filter(
        item =>
          item.node &&
          item.transform
      );


  const frame =
    figma.createFrame();


  frame.name =
    safeName(source);


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


  /*
   * Group에는 자체 Visual 없음.
   */
  if (
    safeType(source) !==
    "GROUP"
  ) {
    copyRootAppearance(
      source,
      frame
    );
  }


  parent.insertChild(
    Math.max(
      index,
      0
    ),
    frame
  );


  try {
    frame.relativeTransform =
      absoluteToRelative(
        sourceTransform,
        parent
      );
  } catch (_) {}


  /*
   * Children 이동.
   *
   * 개별 실패는 Skip.
   */
  for (
    const item of childSnapshots
  ) {
    if (
      !isAlive(
        item.node
      )
    ) {
      continue;
    }


    /*
     * Root Instance가 아닌 Component/Group에서
     * child 이동은 가능해야 한다.
     */
    try {
      frame.appendChild(
        item.node
      );


      item.node.relativeTransform =
        absoluteToRelative(
          item.transform,
          frame
        );

    } catch (error) {
      console.warn(
        "Root child move skipped:",
        safeName(
          item.node
        ),
        error
      );
    }
  }


  /*
   * 모든 Child가 이동하지 못했다면
   * 원본을 지우면 안 된다.
   */
  const remaining =
    childrenOf(source);


  if (
    remaining.length > 0
  ) {
    /*
     * 새 Frame 제거 후 원본 유지.
     */
    safeRemove(frame);

    return source;
  }


  safeRemove(
    source
  );


  return frame;
}


function normalizeRoot(root) {
  if (!isAlive(root)) {
    return null;
  }


  const type =
    safeType(root);


  /*
   * Frame.
   */
  if (
    type === "FRAME"
  ) {
    return root;
  }


  /*
   * Instance.
   *
   * Root는 먼저 Detach.
   */
  if (
    type === "INSTANCE"
  ) {
    try {
      const detached =
        root.detachInstance();


      if (
        detached &&
        isAlive(detached)
      ) {
        if (
          safeType(detached) ===
          "FRAME"
        ) {
          return detached;
        }


        return convertRootToFrame(
          detached
        );
      }

    } catch (error) {
      console.warn(
        "Root Instance detach failed:",
        error
      );


      /*
       * 실패하면 화면을 망가뜨리지 않기 위해
       * Root 자체를 건드리지 않는다.
       */
      return root;
    }
  }


  /*
   * Component / Group.
   */
  return convertRootToFrame(
    root
  );
}


/* =========================================================
   SCREENSHOT / LAYER NAMING
========================================================= */

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
    name.includes("screenshot") ||
    name.includes("screen shot") ||
    name.includes("스크린샷")
  ) {
    return true;
  }


  /*
   * Screen 대부분을 차지하는 이미지.
   */
  try {
    if (
      root.width > 0 &&
      root.height > 0
    ) {
      const widthRatio =
        node.width /
        root.width;


      const heightRatio =
        node.height /
        root.height;


      if (
        widthRatio >= 0.7 &&
        heightRatio >= 0.5
      ) {
        return true;
      }
    }
  } catch (_) {}


  return false;
}


function looksLikeIcon(node) {
  const type =
    safeType(node);


  const name =
    safeName(node)
      .toLowerCase();


  /*
   * 명확한 Vector 계열.
   */
  if (
    type === "VECTOR" ||
    type === "BOOLEAN_OPERATION" ||
    type === "POLYGON" ||
    type === "STAR"
  ) {
    return true;
  }


  /*
   * Ellipse는 무조건 Icon으로 하면
   * Radio / dot / badge까지 전부 icon이 된다.
   *
   * 이름에 icon 계열 표시가 있을 때만 icon.
   */
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


function normalizeLayerName(
  node,
  root
) {
  if (!isAlive(node)) {
    return;
  }


  const type =
    safeType(node);


  /*
   * Text.
   */
  if (
    type === "TEXT"
  ) {
    if (
      renameTextToHyphen
    ) {
      try {
        node.name =
          "-";
      } catch (_) {}
    }


    return;
  }


  /*
   * Line.
   */
  if (
    type === "LINE"
  ) {
    try {
      node.name =
        "line";
    } catch (_) {}


    return;
  }


  /*
   * Icon.
   */
  if (
    looksLikeIcon(node)
  ) {
    try {
      node.name =
        "icon";
    } catch (_) {}


    return;
  }


  /*
   * Image / Shape.
   */
  if (
    type === "RECTANGLE"
  ) {
    try {
      if (
        hasImageFill(node)
      ) {
        node.name =
          looksLikeScreenshot(
            node,
            root
          )
            ? "screenshot"
            : "image";

      } else {
        node.name =
          "shape";
      }

    } catch (_) {}


    return;
  }


  /*
   * 일반 Ellipse.
   */
  if (
    type === "ELLIPSE"
  ) {
    try {
      node.name =
        "shape";
    } catch (_) {}
  }
}


/* =========================================================
   CONTAINER VISUAL SHELL
========================================================= */

/*
 * 안전한 Frame을 제거할 때
 * Frame 자체 Fill / Stroke가 있었다면
 * Rectangle 하나로 복원한다.
 *
 * Effect가 있는 Container는 애초에 Preserve되므로
 * 여기에는 들어오지 않는다.
 */

function snapshotVisual(node) {
  if (!isAlive(node)) {
    return null;
  }


  const transform =
    safeAbsoluteTransform(
      node
    );


  if (!transform) {
    return null;
  }


  const snapshot = {
    width: 1,
    height: 1,

    transform,

    fills: null,
    strokes: null,

    strokeWeight: null,
    strokeAlign: null,

    topLeftRadius: 0,
    topRightRadius: 0,
    bottomLeftRadius: 0,
    bottomRightRadius: 0
  };


  try {
    snapshot.width =
      node.width;

    snapshot.height =
      node.height;
  } catch (_) {}


  try {
    if (
      node.fills !==
      figma.mixed
    ) {
      snapshot.fills =
        node.fills;
    }
  } catch (_) {}


  try {
    if (
      node.strokes !==
      figma.mixed
    ) {
      snapshot.strokes =
        node.strokes;
    }
  } catch (_) {}


  try {
    snapshot.strokeWeight =
      node.strokeWeight;
  } catch (_) {}


  try {
    snapshot.strokeAlign =
      node.strokeAlign;
  } catch (_) {}


  try {
    snapshot.topLeftRadius =
      node.topLeftRadius || 0;

    snapshot.topRightRadius =
      node.topRightRadius || 0;

    snapshot.bottomLeftRadius =
      node.bottomLeftRadius || 0;

    snapshot.bottomRightRadius =
      node.bottomRightRadius || 0;
  } catch (_) {}


  return snapshot;
}


function createVisualShell(
  snapshot,
  root
) {
  if (
    !snapshot ||
    !isAlive(root)
  ) {
    return null;
  }


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
      snapshot.fills !==
      null
    ) {
      rect.fills =
        snapshot.fills;
    }
  } catch (_) {}


  try {
    if (
      snapshot.strokes !==
      null
    ) {
      rect.strokes =
        snapshot.strokes;
    }
  } catch (_) {}


  try {
    if (
      snapshot.strokeWeight !==
      null
    ) {
      rect.strokeWeight =
        snapshot.strokeWeight;
    }
  } catch (_) {}


  try {
    if (
      snapshot.strokeAlign !==
      null
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


  try {
    root.appendChild(
      rect
    );


    rect.relativeTransform =
      absoluteToRelative(
        snapshot.transform,
        root
      );


    return rect;

  } catch (error) {
    console.warn(
      "Visual shell skipped:",
      error
    );


    safeRemove(rect);

    return null;
  }
}


/* =========================================================
   BLOCKED TEXT CHECK
========================================================= */

/*
 * Container 안에 Load할 수 없는 Text가 있으면
 * Container 전체를 Preserve한다.
 *
 * 그래야 Parent를 지우다가
 * Text까지 같이 사라지는 문제를 막을 수 있다.
 */
async function subtreeHasUnmovableText(
  node
) {
  if (!isAlive(node)) {
    return false;
  }


  if (
    safeType(node) ===
    "TEXT"
  ) {
    return !(
      await ensureTextFontsLoaded(
        node
      )
    );
  }


  for (
    const child of
    childrenOf(node)
  ) {
    if (
      await subtreeHasUnmovableText(
        child
      )
    ) {
      return true;
    }
  }


  return false;
}


/* =========================================================
   MOVE
========================================================= */

async function moveNodeToRoot(
  node,
  root,
  stats
) {
  if (
    !isAlive(node) ||
    !isAlive(root)
  ) {
    return false;
  }


  /*
   * Text는 이동 전에 Font Load.
   */
  if (
    safeType(node) ===
    "TEXT"
  ) {
    const loaded =
      await ensureTextFontsLoaded(
        node
      );


    if (!loaded) {
      return false;
    }
  }


  const transform =
    safeAbsoluteTransform(
      node
    );


  if (!transform) {
    return false;
  }


  const originalParent =
    safeParent(node);


  try {
    /*
     * appendChild는 같은 Parent일 경우
     * Z-order만 마지막으로 이동시킨다.
     *
     * Paint Order를 보존하기 위해
     * 의도적으로 실행한다.
     */
    root.appendChild(
      node
    );


    /*
     * Parent가 실제로 바뀐 경우에만
     * 위치 Transform 복원.
     */
    if (
      originalParent !== root
    ) {
      node.relativeTransform =
        absoluteToRelative(
          transform,
          root
        );
    }


    stats.finalLayers++;


    return true;

  } catch (error) {
    console.warn(
      "Layer move skipped:",
      safeName(node),
      error
    );


    return false;
  }
}


/* =========================================================
   GARBAGE
========================================================= */

function shouldDeleteGarbage(node) {
  const id =
    safeId(node);


  if (!id) {
    return false;
  }


  return (
    approvedGarbageIds.has(
      id
    ) &&
    getGarbageReason(node) !==
      null
  );
}


/* =========================================================
   CORE FLATTEN
========================================================= */

/*
 * 이 함수가 안정 버전의 핵심.
 *
 * Container를 만났을 때:
 *
 * 위험함
 * → Container 자체만 Root로 이동
 * → 내부는 건드리지 않음
 *
 * 안전함
 * → Container Visual을 shape로 복원
 * → 내부 Child를 순서대로 Flatten
 * → Container 제거
 *
 * 이렇게 하면 Recursive Paint Order도 최대한 유지된다.
 */

async function flattenNode(
  node,
  root,
  stats
) {
  if (!isAlive(node)) {
    return;
  }


  /* -----------------------------------------------------
     GARBAGE
  ----------------------------------------------------- */

  const garbageReason =
    getGarbageReason(node);


  if (garbageReason) {
    if (
      shouldDeleteGarbage(
        node
      )
    ) {
      if (
        safeRemove(node)
      ) {
        stats.removedGarbage++;
      }

      return;
    }


    /*
     * 체크하지 않은 Garbage는 삭제하지 않음.
     */
    stats.protectedGarbage++;
  }


  /* -----------------------------------------------------
     LEAF
  ----------------------------------------------------- */

  if (
    !isContainer(node)
  ) {
    const moved =
      await moveNodeToRoot(
        node,
        root,
        stats
      );


    if (!moved) {
      /*
       * 개별 Layer 실패는 전체 작업 중단 X.
       */
      stats.preservedAreas++;

      return;
    }


    /*
     * Inter 옵션.
     */
    if (
      safeType(node) ===
        "TEXT" &&
      convertFontToInter
    ) {
      const converted =
        await convertTextToInter(
          node
        );


      if (
        converted > 0
      ) {
        stats.convertedTexts++;

        stats.convertedFontSegments +=
          converted;

      } else {
        stats.failedFontConversions++;
      }
    }


    normalizeLayerName(
      node,
      root
    );


    stats.movedLayers++;


    return;
  }


  /* -----------------------------------------------------
     CONTAINER
  ----------------------------------------------------- */

  /*
   * 먼저 Font 문제 확인.
   *
   * Load할 수 없는 Text가 포함되었다면
   * 해당 Container를 통째로 유지한다.
   */
  let blockedByFont = false;


  try {
    blockedByFont =
      await subtreeHasUnmovableText(
        node
      );
  } catch (_) {
    blockedByFont =
      true;
  }


  const preserve =
    blockedByFont ||
    shouldPreserveContainer(
      node
    );


  /*
   * 위험한 Container.
   */
  if (preserve) {
    const moved =
      await moveNodeToRoot(
        node,
        root,
        stats
      );


    if (moved) {
      stats.preservedAreas++;

    } else {
      /*
       * 안 움직여진다면 그냥 현재 구조에 둔다.
       *
       * Parent가 나중에 삭제되면 안 되므로
       * 상위 flatten 호출에서 이 상황을 보고
       * Container 제거를 중단하게 해야 한다.
       *
       * false 반환 역할을 위해 marker 사용.
       */
      stats.preservedAreas++;
    }


    return;
  }


  /* -----------------------------------------------------
     SAFE CONTAINER
  ----------------------------------------------------- */

  /*
   * Container Background / Stroke 먼저 생성.
   *
   * Paint Order상 Child보다 뒤에 있어야 하므로
   * Child 처리 전에 append.
   */
  if (
    hasOwnVisual(node)
  ) {
    const snapshot =
      snapshotVisual(
        node
      );


    if (snapshot) {
      const shell =
        createVisualShell(
          snapshot,
          root
        );


      if (shell) {
        stats.visualShells++;
        stats.finalLayers++;
      }
    }
  }


  /*
   * Child Paint Order 그대로.
   */
  const children =
    childrenOf(node);


  for (
    const child of children
  ) {
    if (!isAlive(child)) {
      continue;
    }


    await flattenNode(
      child,
      root,
      stats
    );
  }


  /*
   * Child를 모두 빼낸 다음
   * Container가 실제로 비었을 때만 삭제.
   *
   * 뭔가 남아 있다면 절대 삭제하지 않는다.
   */
  if (!isAlive(node)) {
    return;
  }


  const remaining =
    childrenOf(node);


  if (
    remaining.length === 0
  ) {
    if (
      safeRemove(node)
    ) {
      stats.removedContainers++;
    }

  } else {
    /*
     * 이동 실패 Child가 남아있는 경우.
     * Container를 지우면 화면 요소가 같이 삭제되므로 유지.
     */
    stats.preservedAreas++;


    /*
     * 남은 Container가 Root 직속이 아니라면
     * 자체를 Root로 올리는 시도.
     */
    if (
      safeParent(node) !== root &&
      !isInsideInstance(node)
    ) {
      await moveNodeToRoot(
        node,
        root,
        stats
      );
    }
  }
}


/* =========================================================
   ROOT CLEAN
========================================================= */

async function cleanRoot(root) {
  const stats =
    createStats();


  /*
   * 1.
   * 내부 Instance 가능한 것만 Detach.
   */
  detachInstancesSafely(
    root,
    stats
  );


  /*
   * 2.
   * Root Auto Layout 제거 전에
   * Children의 위치는 각 move 시점에
   * absoluteTransform으로 읽는다.
   *
   * Root Layout Mode만 NONE.
   */
  try {
    if (
      safeType(root) ===
        "FRAME" &&
      root.layoutMode !==
        "NONE"
    ) {
      root.layoutMode =
        "NONE";
    }
  } catch (_) {}


  /*
   * 3.
   * Root Children 원래 Paint Order Snapshot.
   */
  const children =
    childrenOf(root);


  /*
   * 4.
   * 하나씩 처리.
   */
  for (
    const child of children
  ) {
    if (!isAlive(child)) {
      continue;
    }


    try {
      await flattenNode(
        child,
        root,
        stats
      );

    } catch (error) {
      /*
       * Layer 하나 오류 → 전체 실패 X.
       */
      console.warn(
        "Layer cleanup skipped:",
        safeName(child),
        error
      );


      stats.preservedAreas++;
    }
  }


  return stats;
}


/* =========================================================
   LAYER ORDER
========================================================= */

function getSimpleBounds(node) {
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


function boundsOverlap(a, b) {
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


/*
 * 겹치는 Layer가 하나라도 있으면
 * 절대로 Z-order를 바꾸지 않는다.
 *
 * 요구사항의 좌표 정렬보다
 * 화면 보존이 우선.
 */
function canSpatiallySort(root) {
  const children =
    childrenOf(root);


  const items =
    children.map(
      node => ({
        node,
        bounds:
          getSimpleBounds(node)
      })
    );


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
        return false;
      }
    }
  }


  return true;
}


function sortSpatiallyIfSafe(root) {
  if (
    !isAlive(root) ||
    !hasChildren(root)
  ) {
    return;
  }


  const children =
    childrenOf(root);


  if (
    children.length <= 1
  ) {
    return;
  }


  /*
   * 복잡한 Screen은 정렬 Skip.
   */
  if (
    !canSpatiallySort(
      root
    )
  ) {
    console.log(
      "Layer sorting skipped - overlapping layers."
    );


    return;
  }


  const items =
    children.map(
      (node, originalIndex) => ({
        node,

        bounds:
          getSimpleBounds(
            node
          ),

        originalIndex
      })
    );


  items.sort(
    (a, b) => {
      if (
        !a.bounds ||
        !b.bounds
      ) {
        return (
          a.originalIndex -
          b.originalIndex
        );
      }


      /*
       * 같은 라인.
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
          ) >
          0.1
        ) {
          return xDiff;
        }
      }


      /*
       * 위 → 아래.
       */
      const yDiff =
        a.bounds.y -
        b.bounds.y;


      if (
        Math.abs(
          yDiff
        ) >
        0.1
      ) {
        return yDiff;
      }


      return (
        a.originalIndex -
        b.originalIndex
      );
    }
  );


  /*
   * Figma Layer Panel은
   * children의 역순으로 보이므로 reverse.
   */
  const figmaOrder =
    [...items]
      .reverse();


  for (
    let index = 0;
    index < figmaOrder.length;
    index++
  ) {
    const node =
      figmaOrder[index].node;


    if (!isAlive(node)) {
      continue;
    }


    try {
      root.insertChild(
        index,
        node
      );

    } catch (error) {
      /*
       * 정렬 실패도 전체 작업 실패 X.
       */
      console.warn(
        "Layer sorting skipped:",
        safeName(node),
        error
      );


      return;
    }
  }
}


/* =========================================================
   ANALYSIS
========================================================= */

function analyzeScreen(root) {
  const result = {
    total: 0,

    garbage: 0,
    garbageItems: [],

    containers: 0,

    instances: 0,
    autoLayouts: 0,

    masks: 0,
    clips: 0,

    text: 0,
    nonInterText: 0,

    icons: 0,
    lines: 0,

    /*
     * UI 호환.
     *
     * 현재 의미는:
     * "Flatten하지 않고 Preserve될 가능성이 있는 영역"
     */
    bakeCandidates: 0
  };


  function walk(
    node,
    path
  ) {
    if (!isAlive(node)) {
      return;
    }


    result.total++;


    const name =
      safeName(node);


    const currentPath =
      path
        ? `${path} / ${name}`
        : name;


    /* ---------------------------------------------
       Garbage
    --------------------------------------------- */

    const garbageReason =
      getGarbageReason(
        node
      );


    if (garbageReason) {
      result.garbage++;


      result.garbageItems.push({
        id:
          safeId(node) || "",

        name,

        type:
          safeType(node) ||
          "UNKNOWN",

        reason:
          garbageReason,

        path:
          currentPath
      });
    }


    /* ---------------------------------------------
       Container
    --------------------------------------------- */

    if (
      node !== root &&
      isContainer(node)
    ) {
      result.containers++;


      if (
        shouldPreserveContainer(
          node
        )
      ) {
        result.bakeCandidates++;
      }
    }


    /* ---------------------------------------------
       Instance
    --------------------------------------------- */

    if (
      safeType(node) ===
      "INSTANCE"
    ) {
      result.instances++;
    }


    /* ---------------------------------------------
       Auto Layout
    --------------------------------------------- */

    try {
      if (
        "layoutMode" in node &&
        node.layoutMode !==
          "NONE"
      ) {
        result.autoLayouts++;
      }
    } catch (_) {}


    /* ---------------------------------------------
       Mask
    --------------------------------------------- */

    try {
      if (
        "isMask" in node &&
        node.isMask === true
      ) {
        result.masks++;
      }
    } catch (_) {}


    /* ---------------------------------------------
       Real Clip
    --------------------------------------------- */

    if (
      node !== root &&
      actuallyClipsChildren(
        node
      )
    ) {
      result.clips++;
    }


    /* ---------------------------------------------
       Text
    --------------------------------------------- */

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


        const nonInter =
          segments.some(
            segment =>
              !segment.fontName ||
              segment.fontName ===
                figma.mixed ||
              segment.fontName.family !==
                "Inter"
          );


        if (nonInter) {
          result.nonInterText++;
        }

      } catch (_) {
        result.nonInterText++;
      }
    }


    /* ---------------------------------------------
       Icon
    --------------------------------------------- */

    if (
      looksLikeIcon(node)
    ) {
      result.icons++;
    }


    /* ---------------------------------------------
       Line
    --------------------------------------------- */

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
   PROCESS ONE ROOT
========================================================= */

async function processRoot(
  originalRoot
) {
  const emptyStats =
    createStats();


  if (!isAlive(originalRoot)) {
    return {
      success: false,

      root:
        originalRoot,

      stats:
        emptyStats
    };
  }


  /*
   * Screen 자체가 다른 Instance 내부라면
   * 이번 안정 버전에서는 건드리지 않는다.
   */
  if (
    isInsideInstance(
      originalRoot
    )
  ) {
    console.warn(
      "Root skipped because it is inside another Instance:",
      safeName(originalRoot)
    );


    return {
      success: false,

      root:
        originalRoot,

      stats:
        emptyStats
    };
  }


  /*
   * Root Frame 정규화.
   */
  let root =
    originalRoot;


  try {
    root =
      normalizeRoot(
        originalRoot
      ) ||
      originalRoot;

  } catch (error) {
    console.warn(
      "Root normalization skipped:",
      safeName(originalRoot),
      error
    );


    root =
      originalRoot;
  }


  if (
    !isAlive(root)
  ) {
    return {
      success: false,

      root:
        originalRoot,

      stats:
        emptyStats
    };
  }


  /*
   * Root Instance detach가 실패해서
   * 아직 Instance라면 내부 조작하지 않는다.
   */
  if (
    safeType(root) ===
    "INSTANCE"
  ) {
    console.warn(
      "Root Instance could not be detached. Screen skipped:",
      safeName(root)
    );


    return {
      success: false,

      root,

      stats:
        emptyStats
    };
  }


  /*
   * Cleanup.
   */
  const stats =
    await cleanRoot(
      root
    );


  /*
   * 좌표 정렬.
   *
   * 겹침 없는 단순 화면일 때만.
   */
  sortSpatiallyIfSafe(
    root
  );


  return {
    success: true,

    root,

    stats
  };
}


/* =========================================================
   UI MESSAGE HANDLER
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
     GARBAGE LAYER VIEW
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


    return;
  }


  /* =====================================================
     CURRENT SELECTION
  ===================================================== */

  const selection =
    [...figma.currentPage.selection]
      .filter(
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


    const resultRoots = [];


    /*
     * 기존 UI와 맞추기 위해
     * committed / rolledBack 필드는 유지한다.
     *
     * 이 버전에서는 Visual Verification을 하지 않으므로:
     *
     * committed
     * = 실제 처리된 Screen
     *
     * rolledBack
     * = 처리하지 않고 Skip한 Screen
     */
    const total = {
      screens:
        selection.length,

      committed: 0,
      rolledBack: 0,

      detachedInstances: 0,

      removedGarbage: 0,
      protectedGarbage: 0,

      removedContainers: 0,
      movedLayers: 0,

      visualShells: 0,

      bakedAreas: 0,
      preservedAreas: 0,

      convertedTexts: 0,
      convertedFontSegments: 0,
      failedFontConversions: 0,

      finalLayers: 0
    };


    try {
      for (
        const originalRoot of
        selection
      ) {
        if (
          !isAlive(
            originalRoot
          )
        ) {
          total.rolledBack++;

          continue;
        }


        /*
         * Screen 하나 실패해도
         * 나머지 Screen 계속.
         */
        try {
          const result =
            await processRoot(
              originalRoot
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
          }


          const stats =
            result.stats;


          for (
            const key of
            Object.keys(stats)
          ) {
            if (
              key in total
            ) {
              total[key] +=
                stats[key];
            }
          }


        } catch (screenError) {
          /*
           * Screen 하나에서 예상 못 한 오류가 나도
           * 플러그인 전체는 중단하지 않는다.
           */
          console.warn(
            "Screen cleanup skipped:",
            safeName(
              originalRoot
            ),
            screenError
          );


          if (
            isAlive(
              originalRoot
            )
          ) {
            resultRoots.push(
              originalRoot
            );
          }


          total.rolledBack++;
        }
      }


      /*
       * 결과 Screen 선택.
       */
      const aliveRoots =
        resultRoots.filter(
          root =>
            isAlive(root)
        );


      if (
        aliveRoots.length >
        0
      ) {
        figma.currentPage.selection =
          aliveRoots;


        figma.viewport
          .scrollAndZoomIntoView(
            aliveRoots
          );
      }


      /*
       * 현재 ui.html과 호환.
       */
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
          `Cleanup 완료 · ${total.rolledBack}개 Screen은 복잡한 구조로 Skip했습니다.`
        );

      } else if (
        total.preservedAreas > 0
      ) {
        figma.notify(
          `Cleanup 완료 · ${total.preservedAreas}개 복잡 영역은 화면 보호를 위해 구조를 유지했습니다.`
        );

      } else {
        figma.notify(
          "Cleanup 완료"
        );
      }


    } catch (error) {
      /*
       * 여기까지 오는 오류는
       * 정말 예외적인 전체 오류.
       */
      console.error(
        "Cleanup error:",
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
