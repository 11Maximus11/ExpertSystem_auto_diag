// ИИдеал Авто — Interactive 3D Diagnostic Vehicle Twin (Filament 3D + 2D Fallback) (2026-11-28)
// Copyright (C) 2026 ИИдеал Авто (LeCodes48 Edition)
// Licensed under the GNU General Public License v3.0 (GPL-3.0).

import type { AffectedSubsystem } from "../../expert.server";
import { appState } from "../state/appState";
import type { SystemKey } from "../types";
import { LucideIcon, THEME, openConfirmModal } from "./components";

export interface SubsystemSpec {
  id: AffectedSubsystem;
  systemKey: SystemKey;
  titleRu: string;
  shortDesc: string;
  diagnosticPrompt: string;
  sensorReadout: () => string;
}

export const SUBSYSTEM_SPECS: SubsystemSpec[] = [
  {
    id: "engine",
    systemKey: "engine",
    titleRu: "Двигатель и Зажигание (ДВС)",
    shortDesc: "Цилиндро-поршневая группа, свечи, катушки, ДМРВ/MAP, впрыск",
    diagnosticPrompt: "Проведи углубленную диагностику двигателя, зажигания и топливной смеси",
    sensorReadout: () => {
      const s = appState.obdSensorsSignal.value;
      return `Обороты: ${s.rpm} об/м | Нагрузка: ${s.engineLoad}% | Дроссель: ${s.throttle}%`;
    },
  },
  {
    id: "cooling",
    systemKey: "cooling",
    titleRu: "Система охлаждения",
    shortDesc: "Радиатор, термостат, помпа, вентиляторы, датчик ДТОЖ",
    diagnosticPrompt: "Проверь систему охлаждения, термостат, вентиляторы и риски перегрева",
    sensorReadout: () => {
      const s = appState.obdSensorsSignal.value;
      return `Т ОЖ: ${s.coolantTemp} °C | Впуск: ${s.intakeTemp} °C`;
    },
  },
  {
    id: "battery",
    systemKey: "battery",
    titleRu: "АКБ, Генератор и ВВБ",
    shortDesc: "Аккумулятор 12В, регулятор напряжения, генератор / тяговая ВВБ",
    diagnosticPrompt: "Выполни диагностику АКБ, зарядки генератора и цепей высокого напряжения",
    sensorReadout: () => {
      const s = appState.obdSensorsSignal.value;
      return `Бортсеть: ${s.voltage.toFixed(1)} В | Порог нормы: 13.6–14.4 В`;
    },
  },
  {
    id: "transmission",
    systemKey: "transmission",
    titleRu: "КПП / Трансмиссия",
    shortDesc: "АКПП, вариатор, гидротрансформатор, соленоиды и датчики скорости",
    diagnosticPrompt: "Диагностируй трансмиссию (АКПП/вариатор), температуру ATF и соленоиды",
    sensorReadout: () => {
      const s = appState.obdSensorsSignal.value;
      return `Скорость: ${s.speed} км/ч | Обороты: ${s.rpm} об/м`;
    },
  },
  {
    id: "electrical",
    systemKey: "electrical",
    titleRu: "ЭБУ, Шина CAN и Проводка",
    shortDesc: "Блок управления ДВС, шина CAN-H/CAN-L, массы кузова и реле",
    diagnosticPrompt: "Проверь шину CAN, питание ЭБУ, массы и потерю связи между модулями (коды U)",
    sensorReadout: () => {
      const s = appState.obdSensorsSignal.value;
      const uCodes = (s.dtcList || []).filter((c) => c.startsWith("U"));
      return uCodes.length > 0 ? `U-коды: ${uCodes.join(", ")}` : `Шина CAN: ${s.voltage.toFixed(1)} В`;
    },
  },
  {
    id: "brakes",
    systemKey: "brakes",
    titleRu: "Тормоза, ABS и ESP",
    shortDesc: "Гидроблок ABS/ESP, датчики колес, тормозные суппорты и колодки",
    diagnosticPrompt: "Проверь тормозную систему, датчики скорости колес ABS/ESP и коды C-серии",
    sensorReadout: () => {
      const s = appState.obdSensorsSignal.value;
      const cCodes = (s.dtcList || []).filter((c) => c.startsWith("C"));
      return cCodes.length > 0 ? `ABS коды: ${cCodes.join(", ")}` : `Скорость: ${s.speed} км/ч`;
    },
  },
  {
    id: "suspension",
    systemKey: "suspension",
    titleRu: "Подвеска, ЭУР и Ходовая",
    shortDesc: "Рулевая рейка ЭУР, датчик SAS, амортизаторы, ШРУС и подшипники",
    diagnosticPrompt: "Проверь электроусилитель руля, датчик угла поворота (SAS) и ходовую часть",
    sensorReadout: () => {
      const s = appState.obdSensorsSignal.value;
      return `Скорость авто: ${s.speed} км/ч • Статус ходовой`;
    },
  },
];

function getScoreForSubsystem(spec: SubsystemSpec): number {
  const scores = appState.systemHealthScoresSignal.value;
  const val = scores[spec.systemKey];
  return typeof val === "number" ? Math.max(5, Math.min(100, Math.round(val))) : 100;
}

function getColorForScore(score: number, isSelected: boolean): { base: string; emissive: [number, number, number] } {
  if (score < 50) {
    return {
      base: "#ef4444",
      emissive: isSelected ? [2.8, 0.35, 0.25] : [1.4, 0.15, 0.1],
    };
  }
  if (score < 80) {
    return {
      base: "#f59e0b",
      emissive: isSelected ? [2.2, 1.1, 0.1] : [0.9, 0.45, 0.05],
    };
  }
  return {
    base: isSelected ? "#38bdf8" : "#10b981",
    emissive: isSelected ? [0.4, 1.4, 2.2] : [0.05, 0.35, 0.2],
  };
}

function openFallbackBlueprintModal(
  initialSubsystem: AffectedSubsystem,
  onDiagnose?: (promptText: string, dtcHints?: string[]) => void
): void {
  const selectedSignal = signal<AffectedSubsystem>(
    SUBSYSTEM_SPECS.some((s) => s.id === initialSubsystem) ? initialSubsystem : "engine"
  );
  let modal: any = null;

  const currentSpec = () =>
    SUBSYSTEM_SPECS.find((s) => s.id === selectedSignal.value) || SUBSYSTEM_SPECS[0];

  const rows = SUBSYSTEM_SPECS.map((spec) => {
    const score = getScoreForSubsystem(spec);
    const barColor =
      score < 50 ? THEME.statusCrit : score < 80 ? THEME.statusWarn : THEME.statusOk;
    return UIButton(
      UIRow(
        UIBox().style({
          width: 10,
          height: 10,
          borderRadius: 5,
          backgroundColor: barColor,
        }),
        UIColumn(
          UIText(spec.titleRu).style({
            color: () => THEME.textPrimary,
            fontSize: 12,
            fontWeight: "bold",
          }),
          UIText(spec.sensorReadout).style({
            color: () => THEME.textMuted,
            fontSize: 10,
          })
        ).style({ flex: 1, gap: 2 }),
        UIText(`${score}%`).style({
          color: barColor,
          fontSize: 12,
          fontWeight: "bold",
        })
      ).style({ alignItems: "center", gap: 8, width: "100%" })
    )
      .style({
        width: "100%",
        backgroundColor: () =>
          selectedSignal.value === spec.id ? THEME.bgElevated : THEME.bgInput,
        borderWidth: 1,
        borderColor: () =>
          selectedSignal.value === spec.id ? THEME.accentOrange : THEME.borderDefault,
        borderRadius: 10,
        padding: 10,
      })
      .onClick(() => {
        selectedSignal.value = spec.id;
      });
  });

  modal = UIModal(
    UIColumn(
      UIRow(
        LucideIcon("lucide:box", 18, () => THEME.accentCyan),
        UIText("Диагностическая карта узлов авто").style({
          color: () => THEME.textPrimary,
          fontSize: 14,
          fontWeight: "bold",
          flex: 1,
        }),
        UIButton(LucideIcon("lucide:x", 18, () => THEME.textMuted))
          .style({ padding: 4 })
          .onClick(() => modal.hide())
      ).style({ alignItems: "center", gap: 8, width: "100%", marginBottom: 8 }),

      UIScrollable(UIColumn(...rows).style({ gap: 6, width: "100%" })).style({
        width: "100%",
        height: 270,
        marginBottom: 10,
      }),

      UIColumn(
        UIText(() => currentSpec().titleRu).style({
          color: () => THEME.accentOrange,
          fontSize: 13,
          fontWeight: "bold",
        }),
        UIText(() => currentSpec().shortDesc).style({
          color: () => THEME.textSecondary,
          fontSize: 11,
          lineHeight: 16,
        })
      ).style({
        width: "100%",
        backgroundColor: () => THEME.bgInput,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        borderRadius: 10,
        padding: 10,
        gap: 3,
        marginBottom: 10,
      }),

      UIRow(
        UIButton(
          UIText("Закрыть").style({
            color: () => THEME.textSecondary,
            fontSize: 12,
            fontWeight: "600",
          })
        )
          .style({
            backgroundColor: () => THEME.bgElevated,
            borderWidth: 1,
            borderColor: () => THEME.borderStrong,
            borderRadius: 10,
            paddingHorizontal: 14,
            paddingVertical: 10,
          })
          .onClick(() => modal.hide()),
        UISpacer(),
        UIButton(
          UIRow(
            LucideIcon("lucide:send", 13, "#ffffff"),
            UIText("Разобрать узел в ИИ").style({
              color: "#ffffff",
              fontSize: 12,
              fontWeight: "bold",
            })
          ).style({ alignItems: "center", gap: 5 })
        )
          .style({
            backgroundColor: THEME.accentOrange,
            borderRadius: 10,
            paddingHorizontal: 14,
            paddingVertical: 10,
          })
          .onClick(() => {
            const spec = currentSpec();
            modal.hide();
            onDiagnose?.(spec.diagnosticPrompt, appState.obdSensorsSignal.value.dtcList);
          })
      ).style({ width: "100%", alignItems: "center" })
    ).style({
      backgroundColor: () => THEME.bgSurface,
      borderRadius: 18,
      padding: 15,
      borderWidth: 1,
      borderColor: () => THEME.borderStrong,
      width: "94%",
    })
  );
  modal.show();
}

export function openVehicle3DInspector(
  initialSubsystem?: AffectedSubsystem,
  onDiagnoseSubsystem?: (promptText: string, dtcHints?: string[]) => void
): void {
  const startFocus: AffectedSubsystem =
    SUBSYSTEM_SPECS.some((s) => s.id === initialSubsystem)
      ? (initialSubsystem as AffectedSubsystem)
      : appState.active3dSubsystemSignal.value || "engine";

  if (!Scene.supported) {
    openFallbackBlueprintModal(startFocus, onDiagnoseSubsystem);
    return;
  }

  try {
    prepare3D();
  } catch (err) {
    console.warn("[3DInspector] prepare3D failed, opening 2D fallback:", err);
    openFallbackBlueprintModal(startFocus, onDiagnoseSubsystem);
    return;
  }

  const selectedSignal = signal<AffectedSubsystem>(startFocus);
  const autoRotateSignal = signal<boolean>(true);
  const yawAngleSignal = signal<number>(0.55);
  const camDistSignal = signal<number>(5.4);
  const sceneStatusSignal = signal<string>("Нажмите на узел автомобиля для осмотра");

  const scene = new Scene({
    skybox: "#090d16",
    environmentIntensity: 18000,
    exposureCompensation: 0.4,
    antialias: 2,
  });

  // Studio Lights
  const sun = Light.sun({
    intensity: 38000,
    color: "#ffffff",
    direction: [-0.45, -1.0, -0.5],
    shadowsQuality: 1,
    shadowDistance: 20,
  });
  const rimLight = Light.point({
    intensity: 1400,
    color: "#38bdf8",
    range: 12,
  });
  rimLight.position = [-2.6, 2.2, 2.5];
  const warmFill = Light.point({
    intensity: 900,
    color: "#f97316",
    range: 10,
  });
  warmFill.position = [2.5, 1.4, -2.0];
  scene.add(sun, rimLight, warmFill);

  // Garage Bay Floor & Safety Perimeter
  const floorMat = Material.lit({ color: "#0f172a", roughness: 0.85, metallic: 0.1 });
  const floor = Mesh.box({ size: [8.5, 0.08, 11.0], position: [0, -0.05, 0], material: floorMat });
  const bayMat = Material.lit({ color: "#1e293b", roughness: 0.5, metallic: 0.4, emissive: [0.05, 0.25, 0.4] });
  const padLeft = Mesh.box({ size: [0.06, 0.02, 5.2], position: [-1.45, 0.01, 0], material: bayMat });
  const padRight = Mesh.box({ size: [0.06, 0.02, 5.2], position: [1.45, 0.01, 0], material: bayMat });
  scene.add(floor, padLeft, padRight);

  // Root Car Node
  const carRoot = new Node();
  carRoot.name = "carRoot";
  scene.add(carRoot);

  // Stylized Car Chassis Silhouette
  const bodyDarkMat = Material.lit({ color: "#1e293b", roughness: 0.35, metallic: 0.65 });
  const cabinGlassMat = Material.lit({ color: "#0f172a", roughness: 0.12, metallic: 0.85, emissive: [0.03, 0.08, 0.15] });
  const tireMat = Material.lit({ color: "#111827", roughness: 0.9, metallic: 0.05 });

  const lowerFloor = Mesh.box({ size: [1.62, 0.18, 4.1], position: [0, 0.26, 0], material: bodyDarkMat });
  const rearDeck = Mesh.box({ size: [1.58, 0.42, 1.15], position: [0, 0.56, -1.35], material: bodyDarkMat });
  const cabinGlass = Mesh.box({ size: [1.42, 0.52, 1.72], position: [0, 0.96, -0.18], material: cabinGlassMat });
  const frontBumper = Mesh.box({ size: [1.62, 0.34, 0.35], position: [0, 0.38, 1.98], material: bodyDarkMat });
  const hoodFrame = Mesh.box({ size: [1.56, 0.06, 1.28], position: [0, 0.78, 1.32], material: cabinGlassMat });
  carRoot.add(lowerFloor, rearDeck, cabinGlass, frontBumper, hoodFrame);

  // 4 Wheels
  const wheelCoords: [number, number, number][] = [
    [-0.86, 0.34, 1.35],
    [0.86, 0.34, 1.35],
    [-0.86, 0.34, -1.3],
    [0.86, 0.34, -1.3],
  ];
  for (const [wx, wy, wz] of wheelCoords) {
    const tire = Mesh.capsule({
      radius: 0.31,
      length: 0.18,
      position: [wx, wy, wz],
      eulerAngles: [0, 0, 90],
      material: tireMat,
      name: "brakes",
    });
    carRoot.add(tire);
  }

  // Clickable Subsystem Nodes & Dynamic Materials
  const subsystemMats = new Map<AffectedSubsystem, Material>();
  const registerMat = (id: AffectedSubsystem): Material => {
    const m = Material.lit({ color: "#10b981", roughness: 0.35, metallic: 0.35 });
    subsystemMats.set(id, m);
    return m;
  };

  // 1. Engine (front bay)
  const engineMat = registerMat("engine");
  const engineBlock = Mesh.box({
    size: [0.68, 0.44, 0.76],
    position: [0, 0.54, 1.18],
    material: engineMat,
    name: "engine",
  });
  const engineValve = Mesh.box({
    size: [0.46, 0.14, 0.64],
    position: [0, 0.80, 1.18],
    material: engineMat,
    name: "engine",
  });
  carRoot.add(engineBlock, engineValve);

  // 2. Cooling (front radiator)
  const coolingMat = registerMat("cooling");
  const radiatorMesh = Mesh.box({
    size: [0.96, 0.38, 0.14],
    position: [0, 0.50, 1.76],
    material: coolingMat,
    name: "cooling",
  });
  carRoot.add(radiatorMesh);

  // 3. Battery / HV Pack (engine bay side)
  const batteryMat = registerMat("battery");
  const batteryMesh = Mesh.box({
    size: [0.34, 0.28, 0.36],
    position: [-0.54, 0.54, 1.36],
    material: batteryMat,
    name: "battery",
  });
  carRoot.add(batteryMesh);

  // 4. Transmission (central tunnel)
  const transMat = registerMat("transmission");
  const transMesh = Mesh.capsule({
    radius: 0.22,
    length: 0.85,
    position: [0, 0.42, 0.25],
    eulerAngles: [90, 0, 0],
    material: transMat,
    name: "transmission",
  });
  carRoot.add(transMesh);

  // 5. Electrical / ECU / CAN Bus
  const elecMat = registerMat("electrical");
  const ecuMesh = Mesh.box({
    size: [0.34, 0.14, 0.30],
    position: [0.50, 0.60, 0.92],
    material: elecMat,
    name: "electrical",
  });
  const canSpine = Mesh.box({
    size: [0.10, 0.06, 2.2],
    position: [0.48, 0.44, -0.1],
    material: elecMat,
    name: "electrical",
  });
  carRoot.add(ecuMesh, canSpine);

  // 6. Brakes (4 brake rotor spheres inside wheels)
  const brakesMat = registerMat("brakes");
  for (const [wx, wy, wz] of wheelCoords) {
    const disc = Mesh.sphere({
      radius: 0.22,
      position: [wx > 0 ? wx + 0.08 : wx - 0.08, wy, wz],
      material: brakesMat,
      name: "brakes",
    });
    carRoot.add(disc);
  }

  // 7. Suspension (front & rear axles)
  const suspMat = registerMat("suspension");
  const frontAxle = Mesh.capsule({
    radius: 0.07,
    length: 1.56,
    position: [0, 0.32, 1.35],
    eulerAngles: [0, 0, 90],
    material: suspMat,
    name: "suspension",
  });
  const rearAxle = Mesh.capsule({
    radius: 0.07,
    length: 1.56,
    position: [0, 0.32, -1.3],
    eulerAngles: [0, 0, 90],
    material: suspMat,
    name: "suspension",
  });
  carRoot.add(frontAxle, rearAxle);

  const syncSubsystemColors = () => {
    const active = selectedSignal.value;
    for (const spec of SUBSYSTEM_SPECS) {
      const mat = subsystemMats.get(spec.id);
      if (!mat) continue;
      const score = getScoreForSubsystem(spec);
      const isSel = spec.id === active;
      const c = getColorForScore(score, isSel);
      mat.color = c.base;
      mat.set("emissive", c.emissive);
    }
  };
  syncSubsystemColors();

  // Click raycast selection on any 3D subsystem
  scene.addEventListener("click", (ev) => {
    let cur = ev.target;
    while (cur) {
      const n = cur.name as AffectedSubsystem;
      if (SUBSYSTEM_SPECS.some((s) => s.id === n)) {
        selectedSignal.value = n;
        syncSubsystemColors();
        const spec = SUBSYSTEM_SPECS.find((s) => s.id === n);
        if (spec) sceneStatusSignal.value = `Выбрано: ${spec.titleRu}`;
        try {
          device.vibrate?.("light");
        } catch (_) {}
        return;
      }
      cur = cur.parent;
    }
  });

  // Motion & Loop Animation
  let motionActive = false;
  if (device.motion.available) {
    try {
      device.motion.start();
      motionActive = true;
    } catch (_) {}
  }

  let loopTime = 0;
  const loopId = setLoop((dt) => {
    loopTime += dt;
    if (autoRotateSignal.value) {
      yawAngleSignal.value += dt * 0.28;
    }

    // RPM-driven realistic engine vibration
    const rpm = appState.obdSensorsSignal.value.rpm || 0;
    if (rpm > 200) {
      const jitter = Math.sin(loopTime * Math.min(80, rpm * 0.04)) * 0.008;
      engineBlock.position = [0, 0.54 + jitter, 1.18];
      engineValve.position = [0, 0.80 + jitter, 1.18];
    }

    let tiltPitch = 0.42;
    if (motionActive) {
      try {
        const g = device.motion.gravity;
        if (g) {
          tiltPitch = Math.max(0.2, Math.min(0.85, 0.44 + (g.z || 0) * 0.18));
        }
      } catch (_) {}
    }

    const r = camDistSignal.value;
    const yaw = yawAngleSignal.value;
    const camX = Math.sin(yaw) * Math.cos(tiltPitch) * r;
    const camY = Math.sin(tiltPitch) * r + 0.55;
    const camZ = Math.cos(yaw) * Math.cos(tiltPitch) * r;
    scene.camera.position = [camX, camY, camZ];
    scene.camera.lookAt([0, 0.52, 0.15]);
  });

  let closed = false;
  const cleanup3D = () => {
    if (closed) return;
    closed = true;
    clearLoop(loopId);
    if (motionActive) {
      try {
        device.motion.stop();
      } catch (_) {}
      motionActive = false;
    }
    try {
      scene.close();
      scene.destroy();
    } catch (_) {}
    Router.restore();
  };

  scene.onBack(cleanup3D);

  const activeSpec = () =>
    SUBSYSTEM_SPECS.find((s) => s.id === selectedSignal.value) || SUBSYSTEM_SPECS[0];

  // Top floating HUD widget
  const topWidget = UIWidget(
    UIRow(
      UIButton(
        UIRow(
          LucideIcon("lucide:chevron-left", 16, "#ffffff"),
          UIText("Назад").style({ color: "#ffffff", fontSize: 12, fontWeight: "bold" })
        ).style({ alignItems: "center", gap: 4 })
      )
        .style({
          backgroundColor: "rgba(15, 23, 42, 0.88)",
          borderWidth: 1,
          borderColor: "#334155",
          borderRadius: 10,
          paddingHorizontal: 10,
          paddingVertical: 7,
        })
        .onClick(cleanup3D),
      UIColumn(
        UIText("3D СКАНЕР УЗЛОВ АВТО").style({
          color: "#f8fafc",
          fontSize: 12,
          fontWeight: "bold",
        }),
        UIText(() => sceneStatusSignal.value).style({
          color: "#38bdf8",
          fontSize: 10,
          lineClamp: 1,
        })
      ).style({ flex: 1, gap: 1 }),
      UIButton(
        LucideIcon(
          "lucide:rotate-ccw",
          15,
          () => (autoRotateSignal.value ? THEME.accentOrange : "#94a3b8")
        )
      )
        .style({
          width: 34,
          height: 34,
          borderRadius: 9,
          backgroundColor: "rgba(15, 23, 42, 0.88)",
          borderWidth: 1,
          borderColor: () => (autoRotateSignal.value ? THEME.accentOrange : "#334155"),
          alignItems: "center",
          justifyContent: "center",
        })
        .onClick(() => {
          autoRotateSignal.value = !autoRotateSignal.value;
        }),
      UIButton(LucideIcon("lucide:camera", 15, () => THEME.accentCyan))
        .style({
          width: 34,
          height: 34,
          borderRadius: 9,
          backgroundColor: "rgba(15, 23, 42, 0.88)",
          borderWidth: 1,
          borderColor: "#334155",
          alignItems: "center",
          justifyContent: "center",
        })
        .onClick(async () => {
          try {
            const snap = await scene.capture();
            appState.stagedItemsSignal.value = [
              ...appState.stagedItemsSignal.value.filter((i) => i.type !== "photo"),
              {
                id: `3d-snap-${Date.now()}`,
                type: "photo",
                label: `3D_${selectedSignal.value}.png`,
                meta: "Снимок 3D-сканера",
                file: snap,
              },
            ];
            cleanup3D();
            appState.activeTabSignal.value = 0;
            toast("3D-снимок узла прикреплен к запросу");
          } catch {
            toast("Снимок 3D недоступен на этом экране");
          }
        })
    ).style({ width: "100%", alignItems: "center", gap: 8 })
  ).style({
    top: 12,
    left: 12,
    right: 12,
    padding: 8,
    borderRadius: 14,
    backgroundColor: "rgba(9, 13, 22, 0.72)",
    borderWidth: 1,
    borderColor: "rgba(51, 65, 85, 0.8)",
  });

  // Subsystem quick selector chips + bottom card
  const bottomWidget = UIWidget(
    UIColumn(
      // Quick subsystem chips
      UIScrollable(
        UIRow(
          ...SUBSYSTEM_SPECS.map((spec) => {
            const score = getScoreForSubsystem(spec);
            return UIButton(
              UIText(`${spec.titleRu.split(" ")[0]} (${score}%)`).style({
                color: () =>
                  selectedSignal.value === spec.id ? "#ffffff" : "#cbd5e1",
                fontSize: 10,
                fontWeight: "bold",
              })
            )
              .style({
                backgroundColor: () =>
                  selectedSignal.value === spec.id ? THEME.accentOrange : "rgba(30, 41, 59, 0.9)",
                borderWidth: 1,
                borderColor: () =>
                  score < 50 ? THEME.statusCrit : selectedSignal.value === spec.id ? THEME.accentOrange : "#475569",
                borderRadius: 8,
                paddingHorizontal: 8,
                paddingVertical: 5,
              })
              .onClick(() => {
                selectedSignal.value = spec.id;
                syncSubsystemColors();
                sceneStatusSignal.value = `Выбрано: ${spec.titleRu}`;
              });
          })
        ).style({ gap: 6, paddingVertical: 2 })
      ).style({
        scrollDirection: "horizontal",
        showScrollbar: false,
        width: "100%",
        height: 30,
      }),

      // Selected Subsystem Details
      UIRow(
        UIColumn(
          UIText(() => activeSpec().titleRu).style({
            color: "#f8fafc",
            fontSize: 14,
            fontWeight: "bold",
          }),
          UIText(() => activeSpec().sensorReadout()).style({
            color: "#38bdf8",
            fontSize: 11,
            fontWeight: "600",
          }),
          UIText(() => activeSpec().shortDesc).style({
            color: "#94a3b8",
            fontSize: 10,
            lineHeight: 14,
          })
        ).style({ flex: 1, gap: 2 }),

        // Orbit controls + Diagnose button
        UIColumn(
          UIRow(
            UIButton(LucideIcon("lucide:chevron-left", 14, "#f8fafc"))
              .style({
                width: 30,
                height: 28,
                borderRadius: 7,
                backgroundColor: "#1e293b",
                alignItems: "center",
                justifyContent: "center",
              })
              .onClick(() => {
                autoRotateSignal.value = false;
                yawAngleSignal.value -= 0.45;
              }),
            UIButton(LucideIcon("lucide:chevron-right", 14, "#f8fafc"))
              .style({
                width: 30,
                height: 28,
                borderRadius: 7,
                backgroundColor: "#1e293b",
                alignItems: "center",
                justifyContent: "center",
              })
              .onClick(() => {
                autoRotateSignal.value = false;
                yawAngleSignal.value += 0.45;
              }),
            UIButton(
              UIText("±").style({ color: "#38bdf8", fontSize: 13, fontWeight: "bold" })
            )
              .style({
                width: 30,
                height: 28,
                borderRadius: 7,
                backgroundColor: "#1e293b",
                alignItems: "center",
                justifyContent: "center",
              })
              .onClick(() => {
                camDistSignal.value = camDistSignal.value > 4.6 ? 3.9 : 5.6;
              })
          ).style({ gap: 4, marginBottom: 6 }),
          UIButton(
            UIRow(
              LucideIcon("lucide:send", 12, "#ffffff"),
              UIText("В ИИ").style({ color: "#ffffff", fontSize: 11, fontWeight: "bold" })
            ).style({ alignItems: "center", gap: 4 })
          )
            .style({
              backgroundColor: THEME.accentOrange,
              borderRadius: 9,
              paddingHorizontal: 12,
              paddingVertical: 7,
              alignItems: "center",
              justifyContent: "center",
            })
            .onClick(() => {
              const spec = activeSpec();
              cleanup3D();
              onDiagnoseSubsystem?.(spec.diagnosticPrompt, appState.obdSensorsSignal.value.dtcList);
            })
        ).style({ alignItems: "flex-end" })
      ).style({ width: "100%", alignItems: "center", gap: 10 })
    ).style({ width: "100%", gap: 8 })
  ).style({
    bottom: 14,
    left: 12,
    right: 12,
    padding: 12,
    borderRadius: 16,
    backgroundColor: "rgba(9, 13, 22, 0.88)",
    borderWidth: 1,
    borderColor: "rgba(51, 65, 85, 0.9)",
  });

  scene.widgets(topWidget, bottomWidget);
  scene.open({ transition: "fade" });
}
