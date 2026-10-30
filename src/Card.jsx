import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import LiquidGlassEffect from './LiquidEffect';
import { Home } from "lucide-react"
const getPillTravel = (menu, isIOS = false) => {
  const menuWidth = menu.offsetWidth;
  const menuBounds = menu.getBoundingClientRect();
  const scale = menuBounds.width / menuWidth;
  const pillWidth = (menuWidth - (isIOS ? 66 : 34)) / 4;
  // Indicator offsets are relative to the menu, not the browser viewport.
  const items = menu.querySelectorAll('a[data-index]');
  const minOffset = 0;
  const step = items.length > 1
    ? (items[1].getBoundingClientRect().left - items[0].getBoundingClientRect().left) / (scale || 1)
    : (menuWidth - pillWidth) / 3;
  const maxOffset = minOffset + Math.max(0, items.length - 1) * step;

  return { menuOrigin: menuBounds.left, scale, pillWidth, minOffset, maxOffset, step, menuWidth };
};

const DEFAULT_GLASS = {
  renderer: 'webgl',
  refraction: .77,
  bevel: 0.42,
  dispersion: 0.80,
  frost: 0.05,
  shine: 1.00,
  roundness: 1.0,
  tint: '#dfeeff3b',
  tintOpacity: 0.08,
};

// Gradually add extra travel at the first and last tabs.
const edgeShift = (position) => 6 * (Math.min(1, Math.max(0, position - 2)) - Math.max(0, 1 - position));

// Damped spring for the shell: bounded time step keeps low frame rates stable.
const springStep = (value, velocity, target, dt) => {
  const nextVelocity = velocity + ((target - value) * 170 - velocity * 24) * dt;
  return [value + nextVelocity * dt, nextVelocity];
};

const Card = () => {
  const [isIOS] = useState(() => typeof navigator !== 'undefined' && (
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  ));
  const [activeIndex, setActiveIndex] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isAutoSliding, setIsAutoSliding] = useState(false);
  const indicatorRef = useRef(null);
  const lensRef = useRef(null);
  const [isSettling, setIsSettling] = useState(false);
  const settleTimerRef = useRef(null);
  const autoSlideRef = useRef(null);
  const dragRef = useRef(null);
  const menuRef = useRef(null);

  const glass = DEFAULT_GLASS;
  // The resting pill and pointer-driven pill use the same measured tab pitch.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const updatePitch = () => {
      const { step } = getPillTravel(menu, isIOS);
      if (step > 0) menu.style.setProperty('--tab-step', `${step}px`);
    };
    updatePitch();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updatePitch) : null;
    observer?.observe(menu);
    window.addEventListener('resize', updatePitch);
    return () => { observer?.disconnect(); window.removeEventListener('resize', updatePitch); };
  }, [isIOS]);
  useEffect(() => () => {
    if (autoSlideRef.current) cancelAnimationFrame(autoSlideRef.current.frameId);
    if (dragRef.current?.frameId != null) cancelAnimationFrame(dragRef.current.frameId);
    clearTimeout(settleTimerRef.current);
  }, []);

  const selectItemUnderPointer = (event) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;

    const menu = event.currentTarget;
    const indicator = indicatorRef.current;
    // Read the scaled viewport position, but reuse tab layout measured on pointer-down.
    const { pillWidth, minOffset, maxOffset, step, menuWidth } = drag.travel;
    const bounds = menu.getBoundingClientRect();
    const scale = bounds.width / menuWidth || 1;
    const pointerOffset = (event.clientX - bounds.left) / scale;

    if (!drag.isDragging) {
      if (Math.abs(event.clientX - drag.startX) < 5) return;

      drag.isDragging = true;
      menu.setPointerCapture(event.pointerId);
      setIsDragging(true);
    }

    const rawOffset = pointerOffset - pillWidth / 2 - (isIOS ? 9 : 5);
    drag.targetOffset = Math.min(
      Math.max(rawOffset, minOffset),
      maxOffset,
    );
    drag.position = (drag.targetOffset - minOffset) / step;
    drag.minOffset = minOffset;
    drag.step = step;

    if (drag.frameId === null) {
      const updatePosition = (timestamp) => {
        const currentDrag = dragRef.current;
        if (!currentDrag) return;

        const elapsed = currentDrag.lastFrameTime === null
          ? 16.67
          : Math.min(timestamp - currentDrag.lastFrameTime, 32);
        currentDrag.lastFrameTime = timestamp;
        const distance = currentDrag.targetOffset - currentDrag.currentOffset;
        const previousOffset = currentDrag.currentOffset;
        currentDrag.currentOffset += distance * (1 - Math.exp(-elapsed / 55));
        if (Math.abs(distance) < 0.02) currentDrag.currentOffset = currentDrag.targetOffset;

        // Mid-bar: a little stretch from motion. Near an end: narrower.
        const position = (currentDrag.currentOffset - currentDrag.minOffset) / currentDrag.step;
        const last = (currentDrag.travel.maxOffset - currentDrag.minOffset) / currentDrag.step;
        const endDistance = Math.min(position, last - position);
        const endWeight = Math.max(0, Math.min(1, 1 - endDistance / 0.7));
        // Keep the outer edge steady while the lens compresses at either end.
        const leftWeight = Math.max(0, Math.min(1, 1 - position / 0.7));
        const rightWeight = Math.max(0, Math.min(1, 1 - (last - position) / 0.7));
        const edgeOrigin = 50 + 50 * (rightWeight - leftWeight);
        const goalShift = Math.max(-5, Math.min(5, -distance * 0.22)) * (1 - 0.85 * endWeight);
        const goalScale = 1 - 0.12 * endWeight + (1 - endWeight) * Math.min(Math.abs(distance) * 0.012, 0.12);
        // A restrained rubber-band response: stretching horizontally narrows
        // the lens vertically; compression near the ends makes it taller.
        const goalScaleY = Math.max(0.94, Math.min(1.05, 1 - (goalScale - 1) * 0.5));
        const dt = Math.min(elapsed, 32) / 1000;
        // Fire once when crossing into the 3px wall zone, not while held there.
        const WALL_ZONE_PX = 2;
        const WALL_IMPACT_SPEED = 2.5; // larger = stronger compression
        const leftWall = currentDrag.minOffset + WALL_ZONE_PX;
        const rightWall = currentDrag.travel.maxOffset - WALL_ZONE_PX;
        const crossedLeft = previousOffset > leftWall && currentDrag.currentOffset <= leftWall && distance < 0;
        const crossedRight = previousOffset < rightWall && currentDrag.currentOffset >= rightWall && distance > 0;
        if (crossedLeft || crossedRight) {
          currentDrag.wallSide = crossedLeft ? 'left' : 'right';
          currentDrag.wallVelocity = -WALL_IMPACT_SPEED;
        }
        // Independent damped spring: squash, rebound, then settle at zero.
        const wallSteps = Math.ceil(dt / (1 / 120));
        const wallDt = dt / wallSteps;
        for (let i = 0; i < wallSteps; i++) {
          currentDrag.wallVelocity += (-40 * currentDrag.wallSquash - 18 * currentDrag.wallVelocity) * wallDt;
          currentDrag.wallSquash += currentDrag.wallVelocity * wallDt;
        }
        if (currentDrag.wallSide) {
          if (Math.abs(currentDrag.wallSquash) < 0.0005 && Math.abs(currentDrag.wallVelocity) < 0.01) {
            currentDrag.wallSquash = 0;
            currentDrag.wallVelocity = 0;
            currentDrag.wallSide = null;
          }
        }
        [currentDrag.jellyX, currentDrag.jellyVelocity] = springStep(currentDrag.jellyX, currentDrag.jellyVelocity, goalShift, dt);
        [currentDrag.jellyScale, currentDrag.scaleVelocity] = springStep(currentDrag.jellyScale, currentDrag.scaleVelocity, goalScale, dt);
        [currentDrag.jellyScaleY, currentDrag.scaleVelocityY] = springStep(currentDrag.jellyScaleY, currentDrag.scaleVelocityY, goalScaleY, dt);
        const wobble = currentDrag.jellyX;
        const stretch = currentDrag.jellyScale;
        const heightStretch = currentDrag.jellyScaleY * (1 + currentDrag.wallSquash);
        indicator.style.setProperty('--jelly-origin', `${edgeOrigin}%`);
        indicator.style.setProperty('--jelly-shift', `${wobble}px`);
        indicator.style.setProperty('--jelly-stretch', `${stretch}`);
        indicator.style.setProperty('--jelly-stretch-y', `${heightStretch}`);
        indicator.style.setProperty('--drag-offset', `${currentDrag.currentOffset}px`);
        indicator.style.setProperty('--edge-shift', `${edgeShift((currentDrag.currentOffset - currentDrag.minOffset) / currentDrag.step)}px`);
        if (menuRef.current) {
          const smoothPosition = (currentDrag.currentOffset - currentDrag.minOffset) / currentDrag.step;
          menuRef.current.style.setProperty('--pill-position', smoothPosition);
        }
        const nextIndex = Math.round((currentDrag.currentOffset - currentDrag.minOffset) / currentDrag.step);
        if (nextIndex !== currentDrag.activeIndex) {
          currentDrag.activeIndex = nextIndex;
          setActiveIndex(nextIndex);
        }

        const stillMoving = Math.abs(currentDrag.currentOffset - currentDrag.targetOffset) > 0.02;
        const stillSettling = Math.abs(currentDrag.jellyX - goalShift) > 0.03 ||
          Math.abs(currentDrag.jellyVelocity) > 0.1 ||
          Math.abs(currentDrag.jellyScale - goalScale) > 0.001 ||
          Math.abs(currentDrag.scaleVelocity) > 0.01 ||
          Math.abs(currentDrag.jellyScaleY - goalScaleY) > 0.001 ||
          Math.abs(currentDrag.scaleVelocityY) > 0.01 ||
          Math.abs(currentDrag.wallSquash) > 0.0005 ||
          Math.abs(currentDrag.wallVelocity) > 0.01;
        if (stillMoving || stillSettling) {
          currentDrag.frameId = requestAnimationFrame(updatePosition);
        } else {
          currentDrag.frameId = null;
          currentDrag.lastFrameTime = null;
        }

      };

      drag.frameId = requestAnimationFrame(updatePosition);
    }
  };

  const startDragging = (event) => {
    if (event.button !== 0) return;
    clearTimeout(settleTimerRef.current);
    setIsSettling(false);

    if (autoSlideRef.current) {
      cancelAnimationFrame(autoSlideRef.current.frameId);
      autoSlideRef.current = null;
      indicatorRef.current?.style.removeProperty('--drag-offset');
      menuRef.current?.style.removeProperty('--pill-position');
      setIsAutoSliding(false);
    }
    const menu = menuRef.current;
    const travel = menu ? getPillTravel(menu, isIOS) : null;
    if (!travel || !travel.step) return;
    const startOffset = travel
      ? travel.minOffset + activeIndex * travel.step
      : 0;
    dragRef.current = {
      pointerId: event.pointerId,
      travel,
      startX: event.clientX,
      isDragging: false,
      targetOffset: startOffset,
      currentOffset: startOffset,
      position: activeIndex,
      activeIndex,
      minOffset: travel?.minOffset ?? 0,
      step: travel?.step ?? 1,
      frameId: null,
      lastFrameTime: null,
      jellyX: 0,
      jellyVelocity: 0,
      jellyScale: 1,
      scaleVelocity: 0,
      jellyScaleY: 1,
      scaleVelocityY: 0,
      wallSquash: 0,
      wallVelocity: 0,
      wallSide: null,
    };
  };

  const stopDragging = (event) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;

    if (!drag.isDragging) {
      dragRef.current = null;
      return;
    }

    if (drag.frameId !== null) cancelAnimationFrame(drag.frameId);
    dragRef.current = null;
    setIsSettling(true);
    clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => setIsSettling(false), 420);
    indicatorRef.current.style.setProperty('--jelly-shift', '0px');
    indicatorRef.current.style.setProperty('--jelly-stretch', '1');
    indicatorRef.current.style.setProperty('--jelly-stretch-y', '1');
    // Keep the drag transform valid until the dragging class is removed.
    if (!isIOS) indicatorRef.current.style.removeProperty('--drag-offset');
    menuRef.current?.style.removeProperty('--pill-position');
    setActiveIndex(Math.round(drag.position));
    setIsDragging(false);
  };

  const selectItem = (index) => {
    if (index === activeIndex) return;
    clearTimeout(settleTimerRef.current);
    setIsSettling(false);

    if (autoSlideRef.current) {
      cancelAnimationFrame(autoSlideRef.current.frameId);
      autoSlideRef.current = null;
    }

    const menu = menuRef.current;
    const indicator = indicatorRef.current;
    if (!menu || !indicator) {
      setActiveIndex(index);
      return;
    }

    const { minOffset, step } = getPillTravel(menu, isIOS);
    const startOffset = minOffset + activeIndex * step;
    const targetOffset = minOffset + index * step;
    const duration = 420;
    let startTime = null;
    indicator.style.setProperty('--drag-offset', `${startOffset}px`);
    indicator.style.setProperty('--edge-shift', `${edgeShift(activeIndex)}px`);
    menu.style.setProperty('--pill-position', activeIndex);
    setIsAutoSliding(true);
    setActiveIndex(index);

    const animateSlide = (timestamp) => {
      if (startTime === null) startTime = timestamp;
      const progress = Math.min((timestamp - startTime) / duration, 1);
      const easedProgress = progress < 0.5
        ? 4 * progress ** 3
        : 1 - ((-2 * progress + 2) ** 3) / 2;
      const offset = startOffset + (targetOffset - startOffset) * easedProgress;
      indicator.style.setProperty('--drag-offset', `${offset}px`);
      indicator.style.setProperty('--edge-shift', `${edgeShift((offset - minOffset) / step)}px`);
      menu.style.setProperty('--pill-position', (offset - minOffset) / step);

      if (progress < 1) {
        autoSlideRef.current = { frameId: requestAnimationFrame(animateSlide) };
        return;
      }

      autoSlideRef.current = null;
      indicator.style.setProperty('--drag-offset', `${targetOffset}px`);
      menu.style.setProperty('--pill-position', index);
      setActiveIndex(index);
      setIsAutoSliding(false);
      setIsSettling(true);
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = setTimeout(() => setIsSettling(false), 420);
    };

    autoSlideRef.current = { frameId: requestAnimationFrame(animateSlide) };
  };

  return (
    <StyledWrapper>
      <div className="unavailable-message" role="status">
        Nav bar not available
      </div>
      <div
        ref={menuRef}
        className={`menu${isIOS ? ' is-ios' : ''}${isDragging ? ' is-dragging' : ''}${isAutoSliding ? ' is-auto-sliding' : ''}${isSettling ? ' is-settling' : ''}${(isAutoSliding || isDragging) ? ' is-glass-moving' : ''}`}
        style={{ '--active-index': activeIndex }}
        onPointerMove={selectItemUnderPointer}
        onPointerDown={startDragging}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
      >
        <a href="#" draggable="false" className={activeIndex === 0 ? 'active' : ''} data-index={0} onClick={(event) => { event.preventDefault(); selectItem(0); }}>
          <Home />
          <span>Home</span>
        </a>
        <a href="#" draggable="false" className={activeIndex === 1 ? 'active' : ''} data-index={1} onClick={(event) => { event.preventDefault(); selectItem(1); }}>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="size-6">
            <path d="M19.5 21a3 3 0 0 0 3-3v-4.5a3 3 0 0 0-3-3h-15a3 3 0 0 0-3 3V18a3 3 0 0 0 3 3h15ZM1.5 10.146V6a3 3 0 0 1 3-3h5.379a2.25 2.25 0 0 1 1.59.659l2.122 2.121c.14.141.331.22.53.22H19.5a3 3 0 0 1 3 3v1.146A4.483 4.483 0 0 0 19.5 9h-15a4.483 4.483 0 0 0-3 1.146Z" />
          </svg>
          <span>About</span>
        </a>
        <a href="#" draggable="false" className={activeIndex === 2 ? 'active' : ''} data-index={2} onClick={(event) => { event.preventDefault(); selectItem(2); }}>
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-tools">
            <path stroke="none" d="M0 0h24v24H0z" fill="none" />
            <path d="M3 21h4l13 -13a1.5 1.5 0 0 0 -4 -4l-13 13v4" />
            <path d="M14.5 5.5l4 4" />
            <path d="M12 8l-5 -5l-4 4l5 5" />
            <path d="M7 8l-1.5 1.5" />
            <path d="M16 12l5 5l-4 4l-5 -5" />
            <path d="M16 17l-1.5 1.5" />
          </svg>
          <span>Tools</span>
        </a>
        <a href="#" draggable="false" className={activeIndex === 3 ? 'active' : ''} data-index={3} onClick={(event) => { event.preventDefault(); selectItem(3); }}>
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-user-circle"><path stroke="none" d="M0 0h24v24H0z" fill="none" /><path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" /><path d="M9 10a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" /><path d="M6.168 18.849a4 4 0 0 1 3.832 -2.849h4a4 4 0 0 1 3.834 2.855" /></svg>
          <span>Account</span>
        </a>
        <div
          ref={indicatorRef}
          className="active-indicator"
          aria-hidden="true"
          style={{
            borderRadius: `${Math.round(4 + glass.roundness * 22)}px`,
          }}
        >
          <div className="moving-glass">
            <div ref={lensRef} className="glass-scene">
              <LiquidGlassEffect
                menuRef={menuRef}
                lensRef={lensRef}
                activeIndex={activeIndex}
                activeColor="#722f37"
                active={isDragging || isAutoSliding}
                {...glass}
              />
            </div>
          </div>
        </div>
      </div>
    </StyledWrapper>
  );
}

const StyledWrapper = styled.div`
  width: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  flex-direction: column;
  gap: 24px;

  .unavailable-message {
    display: none;
  }

  .menu {
    position: relative;
    width: 100%;
    max-width: 403px;
    background: #fff4;
    box-shadow: 0 4px 15px rgba(0, 0, 0, 0.03);
    padding: 8px 5px;
    border-radius: 99rem;
    display: flex;
    justify-content: center;
    gap: 8px;
    z-index: 50;
    touch-action: none;
    --icon-counter-scale: 1;
    transition:
      background-color 0.24s ease,
      transform 0.42s cubic-bezier(0.2, 1.35, 0.35, 1),
      opacity 0.38s ease;
  }

  /* Stay lifted for the whole drag or tap-driven slide, then spring back. */
  .menu.is-dragging,
  .menu.is-auto-sliding {
    transform: scale(1.025);
    --icon-counter-scale: 0.9756097561;
  }

  .menu::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    z-index: 4;
  }

  .active-indicator {
    position: absolute;
    z-index: 3;
    top: 3px;
    bottom: 3px;
    left: 9px;
    width: calc((100% - 66px) / 4);
    box-sizing: border-box;
    margin-left: 0;
    isolation: isolate;
    background: rgba(255, 255, 255, 0.16);
    transform: translateX(calc(var(--active-index) * var(--tab-step, 95px)));
    transition:
      transform 0.42s cubic-bezier(0.22, 1, 0.36, 1),
      border-radius 0.18s ease,
      box-shadow 0.24s ease,
      width 0.24s cubic-bezier(0.22, 1, 0.36, 1),
      margin-left 0.24s cubic-bezier(0.22, 1, 0.36, 1),
      top 0.24s cubic-bezier(0.22, 1, 0.36, 1),
      bottom 0.24s cubic-bezier(0.22, 1, 0.36, 1);
    pointer-events: none;
  }

  .active-indicator.edge-bounce {
    animation: edge-bounce 700ms ease-out;
  }

  @keyframes edge-bounce {
    0%, 100% {
      scale: 1 1;
    }
    35% {
      scale: 1 0.78;
    }
  }

  /* Show the existing lens for the whole drag, without an extra fade mask. */
  .moving-glass {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    right: 0;
    border-radius: 9999px;
    -webkit-clip-path: inset(0 round 9999px);
    clip-path: inset(0 round 9999px);
    overflow: hidden;
    opacity: 0;
    background: rgba(255, 255, 255, 0.10);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.25);
    pointer-events: none;
    transform: translateX(var(--jelly-shift, 0px)) scale(var(--jelly-stretch, 1), var(--jelly-stretch-y, 1));
    transform-origin: var(--jelly-origin, 50%) 50%;
    transition: top 380ms cubic-bezier(0.22, 1, 0.36, 1),
      bottom 380ms cubic-bezier(0.22, 1, 0.36, 1),
      left 380ms cubic-bezier(0.22, 1, 0.36, 1),
      right 380ms cubic-bezier(0.22, 1, 0.36, 1),
      opacity 380ms ease, transform 300ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  .menu.is-glass-moving .moving-glass {
    top: -5px;
    bottom: -5px;
    left: -14px;
    right: -14px;
    opacity: 1;
  }

  /* The glass renderer fills the moving shell, so the actual lens deforms
     with it. The renderer measures its transformed bounds for sampling. */
  .glass-scene {
    position: absolute;
    inset: 0;
    border-radius: inherit;
  }

  /* On release, reveal the stable live icons immediately and let only the
     translucent shell settle. Avoid fading a distorted duplicate over them. */
  .menu:not(.is-dragging):not(.is-auto-sliding) .glass-scene {
    visibility: hidden;
  }
  .menu.is-settling a {
    z-index: 5;
  }

  /* Drag updates already run on animation frames. Do not restart a CSS
     transform transition on every frame: that adds a second layer of lag. */
  .menu.is-dragging .moving-glass {
    transition: inset 320ms cubic-bezier(0.22, 1, 0.36, 1), opacity 320ms ease;
  }

  .menu.is-dragging .active-indicator {
    z-index: 3;
    top: 0;
    bottom: 0;
    left: 5px;
    width: calc((100% - 34px) / 4);
    margin-left: 0;
    transform: translateX(calc(var(--drag-offset) + var(--edge-shift, 0px)));
    transition:
      width 0.24s cubic-bezier(0.22, 1, 0.36, 1),
      margin-left 0.24s cubic-bezier(0.22, 1, 0.36, 1),
      top 0.24s cubic-bezier(0.22, 1, 0.36, 1),
      bottom 0.24s cubic-bezier(0.22, 1, 0.36, 1);
  }

  /* Keep the underlying indicator geometry identical during iOS drag and idle;
     only the separate glass shell grows. This avoids an end-of-drag offset. */
  .menu.is-ios.is-dragging .active-indicator {
    left: 9px;
    width: calc((100% - 66px) / 4);
  }

  .menu.is-auto-sliding .active-indicator {
    z-index: 3;
    top: 3px;
    bottom: 3px;
    left: 9px;
    width: calc((100% - 66px) / 4);
    margin-left: 0;
    transform: translateX(var(--drag-offset));
    transition:
      width 0.24s cubic-bezier(0.22, 1, 0.36, 1),
      margin-left 0.24s cubic-bezier(0.22, 1, 0.36, 1),
      top 0.24s cubic-bezier(0.22, 1, 0.36, 1),
      bottom 0.24s cubic-bezier(0.22, 1, 0.36, 1);
  }

  .menu.is-glass-moving .active-indicator {
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14);
  }

  .menu a {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    flex: 1 1 0;
    min-width: 0;
    color: rgba(255, 255, 255, 90%);
    text-decoration: none;
    padding: 2px 6px;
    border-radius: 999rem;
    -webkit-tap-highlight-color: transparent;
    -webkit-user-drag: none;
    user-select: none;
    /* Counter the menu's vertical scaling around each tab's centre. */
    transform: scaleY(var(--icon-counter-scale));
    transform-origin: center;
    transition:
      color 0.25s ease,
      transform 0.42s cubic-bezier(0.2, 1.35, 0.35, 1);
  }

  .menu a.active {
    color: #722f37;
  }

  .menu a svg {
    width: 1.4rem;
    font-size: 1.4rem;
  }

  .menu a span {
    font-size: 0.8rem;
    font-weight: 600;
    line-height: 1;
    margin-top: 4px;
  }

  .menu a:active {
    transform: scaleY(var(--icon-counter-scale));
  }

  @media (max-width: 370px) {
    .menu {
      display: none;
    }

    .unavailable-message {
      display: block;
      color: #000;
      font-size: 0.9rem;
      text-align: center;
    }
  }

  @media (min-width: 1024px) {
    .menu {
      display: none;
    }

    .unavailable-message {
      display: block;
      color: #000;
      font-size: 0.9rem;
      text-align: center;
    }
  }

  @media (max-width: 370px) {
    .menu {
      display: none;
    }

    .unavailable-message {
      display: block;
      color: #000;
      font-size: 0.9rem;
      text-align: center;
    }
  }

  @media (min-width: 1024px) {
    .menu {
      display: none;
    }

    .unavailable-message {
      display: block;
      color: #000;
      font-size: 0.9rem;
      text-align: center;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .menu, .menu.is-dragging, .menu.is-auto-sliding { transform: none; transition: none; --icon-counter-scale: 1; }
    .menu a { transition: none; }
    .moving-glass, .glass-scene { transform: none; transition: none; }
    .active-indicator.edge-bounce { animation: none; }
    .active-indicator {
      transition-duration: 4ms;
    }
  }
  .menu.is-glass-moving .active-indicator {
  background: transparent;
  border-color: transparent;
  box-shadow: none;
}

/* Match the moving lens to the capsule shape used by roundness: 1.
   Explicit clipping prevents its rectangular canvas/fallback from
   extending into the corners. */
.menu.is-glass-moving .moving-glass {
  border-radius: 9999px;
  -webkit-clip-path: inset(0 round 9999px);
  clip-path: inset(0 round 9999px);
}  
  `;


export default Card;
