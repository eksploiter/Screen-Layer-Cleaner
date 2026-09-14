figma.showUI(__html__, {
  width: 380,
  height: 520,
  themeColors: true
});

/**
 * ============================================
 * Screen Layer Cleaner
 * ============================================
 *
 * 목적
 * 1. 보이지 않는 Garbage Layer 삭제
 * 2. Instance Detach
 * 3. Frame / Group / Auto Layout 제거
 * 4. 모든 실제 레이어를 Screen 바로 아래 1 Depth로 이동
 * 5. 화면의 실제 Visual은 그대로 유지
 * 6. Text Layer 이름 → "-"
 * 7. Vector/Icon → "icon"
 * 8. Line → "line"
 */


/* ------------------------------------------
 * Matrix Utility
 * ------------------------------------------ */

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


/**
 * 특정 레이어의 Absolute Transform을
 * 새로운 부모 기준 Relative Transform으로 변환
 */
function absoluteToRelative(absTransform, newParent) {
  const parentInverse = invertTransform(
    newParent.absoluteTransform
  );

  return multiplyTransform(
    parentInverse,
    absTransform
  );
}


/* ------------------------------------------
 * Layer Type
 * ------------------------------------------ */

function isContainer(node) {
  return (
    node.type === "FRAME" ||
    node.type === "GROUP" ||
    node.type === "COMPONENT" ||
    node.type === "INSTANCE"
  );
}


function isIconLayer(node) {
  return (
    node.type === "VECTOR" ||
    node.type === "BOOLEAN_OPERATION" ||
    node.type === "STAR" ||
    node.type === "POLYGON" ||
    node.type === "ELLIPSE"
  );
}


/* ------------------------------------------
 * Garbage
 * ------------------------------------------ */

/**
 * 확실하게 현재 화면에 렌더링되지 않는 경우만 삭제
 *
 * visible false
 * opacity 0
 */
function isGarbage(node) {
  if ("visible" in node && node.visible === false) {
    return true;
  }

  if ("opacity" in node && node.opacity === 0) {
    return true;
  }

  return false;
}


/* ------------------------------------------
 * Paint Detection
 * ------------------------------------------ */

function hasVisiblePaint(paints) {
  if (!Array.isArray(paints)) {
    return false;
  }

  return paints.some((paint) => {
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


function containerHasOwnVisual(node) {
  if (
    "fills" in node &&
    hasVisiblePaint(node.fills)
  ) {
    return true;
  }

  if (
    "strokes" in node &&
    hasVisiblePaint(node.strokes)
  ) {
    return true;
  }

  if (
    "effects" in node &&
    Array.isArray(node.effects) &&
    node.effects.some(
      effect => effect.visible !== false
    )
  ) {
    return true;
  }

  return false;
}


/* ------------------------------------------
 * Safety
 * ------------------------------------------ */

/**
 * Flatten 과정에서 화면이 달라질 가능성이 매우 높은 구조.
 *
 * 이런 구조는 억지로 변경하지 않는다.
 */
function findUnsafeLayers(root) {
  const unsafe = [];

  function walk(node) {
    if (node !== root) {
      if (
        "clipsContent" in node &&
        node.clipsContent === true
      ) {
        unsafe.push({
          node,
          reason: "Clip Content"
        });
      }

      if (
        "isMask" in node &&
        node.isMask === true
      ) {
        unsafe.push({
          node,
          reason: "Mask"
        });
      }

      /*
       * 부모 전체 투명도가 적용돼 있을 경우
       * Child를 밖으로 이동시키면 composite 결과가 달라질 수 있음
       */
      if (
        isContainer(node) &&
        "opacity" in node &&
        node.opacity !== 1
      ) {
        unsafe.push({
          node,
          reason: "Container Opacity"
        });
      }

      if (
        isContainer(node) &&
        "blendMode" in node &&
        node.blendMode !== "PASS_THROUGH" &&
        node.blendMode !== "NORMAL"
      ) {
        unsafe.push({
          node,
          reason: "Container Blend Mode"
        });
      }
    }

    if ("children" in node) {
      for (const child of node.children) {
        walk(child);
      }
    }
  }

  walk(root);

  return unsafe;
}


/* ------------------------------------------
 * Container Visual → Rectangle
 * ------------------------------------------ */

/**
 * Frame / AutoLayout 자체에
 *
 * - Background
 * - Stroke
 * - Shadow
 *
 * 가 존재한다면 Frame을 삭제할 때 화면도 사라진다.
 *
 * 따라서 Frame의 Visual만 Rectangle로 복원한다.
 */
function createVisualShell(container, root) {
  if (!containerHasOwnVisual(container)) {
    return null;
  }

  const rect = figma.createRectangle();

  rect.name = container.name;

  rect.resize(
    Math.max(container.width, 0.01),
    Math.max(container.height, 0.01)
  );

  /*
   * Fill
   */
  if (
    "fills" in container &&
    container.fills !== figma.mixed
  ) {
    try {
      rect.fills = container.fills;
    } catch (e) {}
  }

  /*
   * Stroke
   */
  if (
    "strokes" in container &&
    container.strokes !== figma.mixed
  ) {
    try {
      rect.strokes = container.strokes;
    } catch (e) {}
  }

  if ("strokeWeight" in container) {
    try {
      rect.strokeWeight = container.strokeWeight;
    } catch (e) {}
  }

  if ("strokeAlign" in container) {
    try {
      rect.strokeAlign = container.strokeAlign;
    } catch (e) {}
  }

  /*
   * Effects
   */
  if (
    "effects" in container &&
    container.effects !== figma.mixed
  ) {
    try {
      rect.effects = container.effects;
    } catch (e) {}
  }

  /*
   * Corner Radius
   */
  try {
    if (
      "topLeftRadius" in container &&
      "topRightRadius" in container &&
      "bottomLeftRadius" in container &&
      "bottomRightRadius" in container
    ) {
      rect.topLeftRadius =
        container.topLeftRadius;

      rect.topRightRadius =
        container.topRightRadius;

      rect.bottomLeftRadius =
        container.bottomLeftRadius;

      rect.bottomRightRadius =
        container.bottomRightRadius;
    }
  } catch (e) {}

  /*
   * Absolute position 저장
   */
  const abs = container.absoluteTransform;

  root.appendChild(rect);

  rect.relativeTransform =
    absoluteToRelative(abs, root);

  return rect;
}


/* ------------------------------------------
 * Instance Detach
 * ------------------------------------------ */

function detachInstances(parent) {
  if (!("children" in parent)) {
    return;
  }

  /*
   * detach를 하면 children collection이 변경되기 때문에
   * snapshot 사용
   */
  const children = [...parent.children];

  for (const child of children) {
    let target = child;

    if (child.type === "INSTANCE") {
      try {
        target = child.detachInstance();
      } catch (error) {
        console.warn(
          "Could not detach instance:",
          child.name,
          error
        );
      }
    }

    if ("children" in target) {
      detachInstances(target);
    }
  }
}


/* ------------------------------------------
 * Rename
 * ------------------------------------------ */

function renameLayer(node) {
  /*
   * 화면 Text 내용은 건드리지 않는다.
   * node.characters 변경 절대 X
   */
  if (node.type === "TEXT") {
    node.name = "-";
    return;
  }

  if (node.type === "LINE") {
    node.name = "line";
    return;
  }

  if (isIconLayer(node)) {
    node.name = "icon";
  }
}


/* ------------------------------------------
 * Flatten
 * ------------------------------------------ */

function flattenScreen(root) {
  let garbageCount = 0;
  let movedCount = 0;
  let renamedCount = 0;
  let shellCount = 0;

  /*
   * Root 자체가 Auto Layout이면
   * Child 이동 전에 해제.
   *
   * Root Frame 자체는 화면 Screen 유지를 위해 남긴다.
   */
  if (
    root.type === "FRAME" ||
    root.type === "COMPONENT"
  ) {
    if ("layoutMode" in root) {
      root.layoutMode = "NONE";
    }
  }

  /*
   * 먼저 Instance Detach
   */
  detachInstances(root);


  /**
   * 최종적으로 Root 바로 아래에 놓을 레이어 목록.
   *
   * DFS 순서이므로 기존 Z-order도 최대한 그대로 유지됨.
   */
  const renderItems = [];


  function collect(node) {
    /*
     * Garbage container라면
     * 그 아래 전체도 화면에 안 보이므로 통째로 제거
     */
    if (isGarbage(node)) {
      garbageCount++;

      try {
        node.remove();
      } catch (e) {}

      return;
    }


    /*
     * Container
     */
    if (isContainer(node)) {
      /*
       * Frame 자체에 Background 등이 있는 경우
       * Rectangle shell 생성 예약
       */
      if (containerHasOwnVisual(node)) {
        renderItems.push({
          type: "shell",
          source: node
        });
      }

      if ("children" in node) {
        const children = [...node.children];

        for (const child of children) {
          collect(child);
        }
      }

      return;
    }


    /*
     * 일반 실제 렌더링 Layer
     */
    renderItems.push({
      type: "node",
      source: node
    });
  }


  /*
   * Root 자체가 아닌 Children부터
   */
  const topChildren = [...root.children];

  for (const child of topChildren) {
    collect(child);
  }


  /*
   * Absolute Transform은
   * Parent가 삭제되기 전에 저장해야 한다.
   */
  const preparedItems = [];

  for (const item of renderItems) {
    if (!item.source || item.source.removed) {
      continue;
    }

    if (item.type === "node") {
      preparedItems.push({
        type: "node",
        node: item.source,
        absoluteTransform:
          item.source.absoluteTransform
      });
    }

    if (item.type === "shell") {
      preparedItems.push({
        type: "shell",
        source: item.source,
        absoluteTransform:
          item.source.absoluteTransform
      });
    }
  }


  /*
   * Visual Shell을 실제 Rectangle로 만든다.
   *
   * Node 이동 전에 만들어서 Z-order를 보존.
   */
  const finalNodes = [];

  for (const item of preparedItems) {
    if (item.type === "shell") {
      const source = item.source;

      if (!source || source.removed) {
        continue;
      }

      const shell =
        createVisualShell(source, root);

      if (shell) {
        shell.relativeTransform =
          absoluteToRelative(
            item.absoluteTransform,
            root
          );

        finalNodes.push(shell);
        shellCount++;
      }

      continue;
    }

    finalNodes.push({
      node: item.node,
      absoluteTransform:
        item.absoluteTransform
    });
  }


  /*
   * 실제 Leaf Layer 이동
   */
  for (const item of finalNodes) {
    /*
     * Shell Rectangle
     */
    if (
      item &&
      item.type === "RECTANGLE"
    ) {
      continue;
    }


    if (!item.node || item.node.removed) {
      continue;
    }

    try {
      root.appendChild(item.node);

      item.node.relativeTransform =
        absoluteToRelative(
          item.absoluteTransform,
          root
        );

      movedCount++;

      const before = item.node.name;

      renameLayer(item.node);

      if (before !== item.node.name) {
        renamedCount++;
      }

    } catch (error) {
      console.warn(
        "Failed to move:",
        item.node.name,
        error
      );
    }
  }


  /*
   * 이제 남아있는 Container 제거
   *
   * Leaf Layer는 이미 Root로 이동했기 때문에
   * Container만 제거된다.
   */
  function removeContainers(parent) {
    if (!("children" in parent)) {
      return;
    }

    const children = [...parent.children];

    for (const child of children) {
      if (isContainer(child)) {
        try {
          child.remove();
        } catch (e) {}
      }
    }
  }

  removeContainers(root);


  /*
   * 생성된 Shell도 Layer Name 정리 대상에서
   * 제외하고 기존 이름 유지.
   *
   * 필요하면 추후
   * rect / background 등으로 바꿀 수 있음.
   */


  return {
    garbageCount,
    movedCount,
    renamedCount,
    shellCount
  };
}


/* ------------------------------------------
 * Analyze
 * ------------------------------------------ */

function analyzeScreen(root) {
  let total = 0;
  let garbage = 0;
  let containers = 0;
  let text = 0;
  let icons = 0;
  let lines = 0;

  function walk(node) {
    total++;

    if (isGarbage(node)) {
      garbage++;
    }

    if (node !== root && isContainer(node)) {
      containers++;
    }

    if (node.type === "TEXT") {
      text++;
    }

    if (node.type === "LINE") {
      lines++;
    }

    if (isIconLayer(node)) {
      icons++;
    }

    if ("children" in node) {
      for (const child of node.children) {
        walk(child);
      }
    }
  }

  walk(root);

  const unsafe = findUnsafeLayers(root);

  return {
    total,
    garbage,
    containers,
    text,
    icons,
    lines,
    unsafe
  };
}


/* ------------------------------------------
 * UI Message
 * ------------------------------------------ */

figma.ui.onmessage = async (msg) => {

  if (msg.type === "close") {
    figma.closePlugin();
    return;
  }


  const selection =
    figma.currentPage.selection;


  if (selection.length === 0) {
    figma.ui.postMessage({
      type: "error",
      message:
        "정리할 Screen Frame을 선택해주세요."
    });

    return;
  }


  /*
   * 현재 버전에서는 안전성을 위해
   * Screen 단위 작업만 허용
   */
  const roots = selection.filter(
    node => node.type === "FRAME"
  );


  if (roots.length !== selection.length) {
    figma.ui.postMessage({
      type: "error",
      message:
        "현재 버전은 최상위 Screen Frame만 선택할 수 있습니다."
    });

    return;
  }


  /* Analyze */
  if (msg.type === "analyze") {

    const results = roots.map(root => ({
      name: root.name,
      ...analyzeScreen(root)
    }));

    figma.ui.postMessage({
      type: "analysis",
      results
    });

    return;
  }


  /* Clean */
  if (msg.type === "clean") {

    /*
     * 수정 전에 전체 안전성 검사
     */
    const allUnsafe = [];

    for (const root of roots) {

      const unsafe =
        findUnsafeLayers(root);

      if (unsafe.length > 0) {
        allUnsafe.push({
          root,
          unsafe
        });
      }
    }


    /*
     * Mask / Clip 등이 존재하면
     * 화면 보존을 위해 수정하지 않는다.
     */
    if (allUnsafe.length > 0) {

      const names = [];

      for (const result of allUnsafe) {
        for (const item of result.unsafe) {
          names.push(
            `${result.root.name} → ${item.node.name} (${item.reason})`
          );
        }
      }

      figma.ui.postMessage({
        type: "unsafe",
        layers: names
      });

      return;
    }


    let totalGarbage = 0;
    let totalMoved = 0;
    let totalRenamed = 0;
    let totalShell = 0;


    for (const root of roots) {
      const result =
        flattenScreen(root);

      totalGarbage +=
        result.garbageCount;

      totalMoved +=
        result.movedCount;

      totalRenamed +=
        result.renamedCount;

      totalShell +=
        result.shellCount;
    }


    figma.currentPage.selection =
      roots;


    figma.viewport.scrollAndZoomIntoView(
      roots
    );


    figma.ui.postMessage({
      type: "complete",

      result: {
        screens: roots.length,
        garbage: totalGarbage,
        moved: totalMoved,
        renamed: totalRenamed,
        shell: totalShell
      }
    });


    figma.notify(
      `Screen Layer Cleaner 완료 · ${totalMoved}개 레이어 정리`
    );
  }
};
