/**
 * Copyright 2015 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as dom from '../../../src/dom';
import * as st from '../../../src/style';
import * as tr from '../../../src/transition';
import {Animation} from '../../../src/animation';
import {CSS} from '../../../build/amp-image-lightbox-0.1.css';
import {
  DoubletapRecognizer,
  SwipeXYRecognizer,
  TapRecognizer,
  TapzoomRecognizer,
} from '../../../src/gesture-recognizers';
import {Gestures} from '../../../src/gesture';
import {Keys} from '../../../src/core/constants/key-codes';
import {Services} from '../../../src/services';
import {WindowInterface} from '../../../src/window-interface';
import {bezierCurve} from '../../../src/core/data-structures/curve';
import {boundValue, clamp, distance, magnitude} from '../../../src/utils/math';
import {continueMotion} from '../../../src/motion';
import {dev, userAssert} from '../../../src/log';
import {isLoaded} from '../../../src/event-helper';
import {
  layoutRectFromDomRect,
  layoutRectLtwh,
  moveLayoutRect,
} from '../../../src/layout-rect';
import {propagateAttributes} from '../../../src/core/dom/propagate-attributes';
import {setStyles, toggle} from '../../../src/style';
import {srcsetFromElement} from '../../../src/srcset';

const TAG = 'amp-image-lightbox';

/** @private @const {!Set<string>} */
const SUPPORTED_ELEMENTS_ = new Set(['amp-img', 'amp-anim', 'img']);

/** @private @const */
const ARIA_ATTRIBUTES = ['aria-label', 'aria-describedby', 'aria-labelledby'];

/** @private @const {!../../../src/core/data-structures/curve.CurveDef} */
const ENTER_CURVE_ = bezierCurve(0.4, 0, 0.2, 1);

/** @private @const {!../../../src/core/data-structures/curve.CurveDef} */
const EXIT_CURVE_ = bezierCurve(0.4, 0, 0.2, 1);

/** @private @const {!../../../src/core/data-structures/curve.CurveDef} */
const PAN_ZOOM_CURVE_ = bezierCurve(0.4, 0, 0.2, 1.4);

/** @private @const {number} */
const DEFAULT_MAX_SCALE = 2;

/**
 * This class is responsible providing all operations necessary for viewing
 * an image, such as full-bleed display, zoom and pan, etc.
 * @package  Visible for testing only!
 * TODO(dvoytenko): move to the separate file once build system is ready.
 */
export class ImageViewer {
  /**
   * @param {!AmpImageLightbox} lightbox
   * @param {!Window} win
   * @param {function(T, number=):Promise<T>} loadPromise
   * @template T
   */
  constructor(lightbox, win, loadPromise) {
    /** @private {!AmpImageLightbox} */
    this.lightbox_ = lightbox;

    /** @const {!Window} */
    this.win = win;

    /** @private {function(T, number=):Promise<T>} */
    this.loadPromise_ = loadPromise;

    /** @private {!Element} */
    this.viewer_ = lightbox.element.ownerDocument.createElement('div');
    this.viewer_.classList.add('i-amphtml-image-lightbox-viewer');

    /** @private {!Element} */
    this.image_ = lightbox.element.ownerDocument.createElement('img');
    this.image_.classList.add('i-amphtml-image-lightbox-viewer-image');
    this.viewer_.appendChild(this.image_);

    /** @private {?../../../src/srcset.Srcset} */
    this.srcset_ = null;

    /** @private {number} */
    this.sourceWidth_ = 0;

    /** @private {number} */
    this.sourceHeight_ = 0;

    /** @private {!../../../src/layout-rect.LayoutRectDef} */
    this.viewerBox_ = layoutRectLtwh(0, 0, 0, 0);

    /** @private {!../../../src/layout-rect.LayoutRectDef} */
    this.imageBox_ = layoutRectLtwh(0, 0, 0, 0);

    /** @private {number} */
    this.scale_ = 1;
    /** @private {number} */
    this.startScale_ = 1;
    /** @private {number} */
    this.maxSeenScale_ = 1;
    /** @private {number} */
    this.minScale_ = 1;
    /** @private {number} */
    this.maxScale_ = DEFAULT_MAX_SCALE;

    /** @private {number} */
    this.startX_ = 0;
    /** @private {number} */
    this.startY_ = 0;
    /** @private {number} */
    this.posX_ = 0;
    /** @private {number} */
    this.posY_ = 0;
    /** @private {number} */
    this.minX_ = 0;
    /** @private {number} */
    this.minY_ = 0;
    /** @private {number} */
    this.maxX_ = 0;
    /** @private {number} */
    this.maxY_ = 0;

    /** @private {?../../../src/motion.Motion} */
    this.motion_ = null;

    this.setupGestures_();
  }

  /**
   * Returns the root element of the image viewer.
   * @return {!Element}
   */
  getElement() {
    return this.viewer_;
  }

  /**
   * Returns the img element of the image viewer.
   * @return {!Element}
   */
  getImage() {
    return this.image_;
  }

  /**
   * Returns the boundaries of the viewer.
   * @return {!../../../src/layout-rect.LayoutRectDef}
   */
  getViewerBox() {
    return this.viewerBox_;
  }

  /**
   * Returns the boundaries of the image element.
   * @return {!../../../src/layout-rect.LayoutRectDef}
   */
  getImageBox() {
    return this.imageBox_;
  }

  /**
   * Returns the boundaries of the image element with the offset if it was
   * moved by a gesture.
   * @return {!../../../src/layout-rect.LayoutRectDef}
   */
  getImageBoxWithOffset() {
    if (this.posX_ == 0 && this.posY_ == 0) {
      return this.imageBox_;
    }
    return moveLayoutRect(this.imageBox_, this.posX_, this.posY_);
  }

  /**
   * Resets the image viewer to the initial state.
   */
  reset() {
    this.image_.setAttribute('src', '');
    ARIA_ATTRIBUTES.forEach((key) => {
      this.image_.removeAttribute(key);
    });
    this.image_.removeAttribute('aria-describedby');
    this.srcset_ = null;
    this.imageBox_ = layoutRectLtwh(0, 0, 0, 0);
    this.sourceWidth_ = 0;
    this.sourceHeight_ = 0;

    this.maxSeenScale_ = 1;
    this.scale_ = 1;
    this.startScale_ = 1;
    this.maxScale_ = 2;

    this.startX_ = 0;
    this.startY_ = 0;
    this.posX_ = 0;
    this.posY_ = 0;
    this.minX_ = 0;
    this.minY_ = 0;
    this.maxX_ = 0;
    this.maxY_ = 0;

    if (this.motion_) {
      this.motion_.halt();
    }
    this.motion_ = null;
  }

  /**
   * Sets the source width and height based the natural dimensions of the
   * source image if loaded, and the offset dimensions of amp-img element
   * if not.
   * @param {!Element} ampImg
   * @param {?Element} img
   * @private
   */
  setSourceDimensions_(ampImg, img) {
    if (img) {
      this.sourceWidth_ = img.naturalWidth || ampImg./*OK*/ offsetWidth;
      this.sourceHeight_ = img.naturalHeight || ampImg./*OK*/ offsetHeight;
    } else {
      this.sourceWidth_ = ampImg./*OK*/ offsetWidth;
      this.sourceHeight_ = ampImg./*OK*/ offsetHeight;
    }
  }

  /**
   * Initializes the image viewer to the target image element such as
   * "amp-img". The target image element may or may not yet have the img
   * element initialized.
   * @param {!Element} sourceElement
   * @param {?Element} sourceImage
   */
  init(sourceElement, sourceImage) {
    this.setSourceDimensions_(sourceElement, sourceImage);
    this.srcset_ = srcsetFromElement(sourceElement);

    if (sourceElement.tagName.toLowerCase() === 'img') {
      propagateAttributes(ARIA_ATTRIBUTES, sourceElement, this.image_);
    } else {
      sourceElement
        .getImpl()
        .then((impl) =>
          propagateAttributes(ARIA_ATTRIBUTES, impl.element, this.image_)
        );
    }

    if (sourceImage && isLoaded(sourceImage) && sourceImage.src) {
      // Set src provisionally to the known loaded value for fast display.
      // It will be updated later.
      this.image_.setAttribute('src', sourceImage.src);
    }
  }

  /**
   * Measures the image viewer and image sizes and positioning.
   * @return {!Promise}
   */
  measure() {
    this.viewerBox_ = layoutRectFromDomRect(
      this.viewer_./*OK*/ getBoundingClientRect()
    );
    const sourceAspectRatio = this.sourceWidth_ / this.sourceHeight_;
    let height = Math.min(
      this.viewerBox_.width / sourceAspectRatio,
      this.viewerBox_.height
    );
    let width = Math.min(
      this.viewerBox_.height * sourceAspectRatio,
      this.viewerBox_.width
    );

    // TODO(dvoytenko): This is to reduce very small expansions that often
    // look like a stutter. To be evaluated if this is still the right
    // idea.
    if (
      Math.abs(width - this.sourceWidth_) <= 16 &&
      Math.abs(height - this.sourceHeight_) <= 16
    ) {
      width = this.sourceWidth_;
      height = this.sourceHeight_;
    }

    this.imageBox_ = layoutRectLtwh(
      Math.round((this.viewerBox_.width - width) / 2),
      Math.round((this.viewerBox_.height - height) / 2),
      Math.round(width),
      Math.round(height)
    );

    setStyles(this.image_, {
      top: st.px(this.imageBox_.top),
      left: st.px(this.imageBox_.left),
      width: st.px(this.imageBox_.width),
      height: st.px(this.imageBox_.height),
    });

    // If aspect ratio is off by too much, adjust max scale
    const viewerBoxRatio = this.viewerBox_.width / this.viewerBox_.height;
    const maxScale = Math.max(
      viewerBoxRatio / sourceAspectRatio,
      sourceAspectRatio / viewerBoxRatio
    );
    this.maxScale_ = Math.max(DEFAULT_MAX_SCALE, maxScale);

    // Reset zoom and pan.
    this.startScale_ = this.scale_ = 1;
    this.startX_ = this.posX_ = 0;
    this.startY_ = this.posY_ = 0;
    this.updatePanZoomBounds_(this.scale_);
    this.updatePanZoom_();

    return this.updateSrc_();
  }

  /**
   * @return {!Promise}
   * @private
   */
  updateSrc_() {
    if (!this.srcset_) {
      // Do not update source if the lightbox has already exited.
      return Promise.resolve();
    }
    this.maxSeenScale_ = Math.max(this.maxSeenScale_, this.scale_);
    const width = this.imageBox_.width * this.maxSeenScale_;
    const src = this.srcset_.select(
      width,
      WindowInterface.getDevicePixelRatio()
    );
    if (src == this.image_.getAttribute('src')) {
      return Promise.resolve();
    }
    // Notice that we will wait until the next event cycle to set the "src".
    // This ensures that the already available image will show immediately
    // and then naturally upgrade to a higher quality image.
    return Services.timerFor(this.win)
      .promise(1)
      .then(() => {
        this.image_.setAttribute('src', src);
        return this.loadPromise_(this.image_);
      });
  }

  /** @private */
  setupGestures_() {
    const gestures = Gestures.get(this.image_);

    // Toggle viewer mode.
    gestures.onGesture(TapRecognizer, () => {
      this.lightbox_.toggleViewMode();
    });

    // Movable.
    gestures.onGesture(SwipeXYRecognizer, (e) => {
      this.onMove_(e.data.deltaX, e.data.deltaY, false);
      if (e.data.last) {
        this.onMoveRelease_(e.data.velocityX, e.data.velocityY);
      }
    });
    gestures.onPointerDown(() => {
      if (this.motion_) {
        this.motion_.halt();
      }
    });

    // Zoomable.
    gestures.onGesture(DoubletapRecognizer, (e) => {
      let newScale;
      if (this.scale_ == 1) {
        newScale = this.maxScale_;
      } else {
        newScale = this.minScale_;
      }
      const deltaX = this.viewerBox_.width / 2 - e.data.clientX;
      const deltaY = this.viewerBox_.height / 2 - e.data.clientY;
      this.onZoom_(newScale, deltaX, deltaY, true).then(() => {
        return this.onZoomRelease_(0, 0, 0, 0, 0, 0);
      });
    });
    gestures.onGesture(TapzoomRecognizer, (e) => {
      this.onZoomInc_(
        e.data.centerClientX,
        e.data.centerClientY,
        e.data.deltaX,
        e.data.deltaY
      );
      if (e.data.last) {
        this.onZoomRelease_(
          e.data.centerClientX,
          e.data.centerClientY,
          e.data.deltaX,
          e.data.deltaY,
          e.data.velocityY,
          e.data.velocityY
        );
      }
    });
  }

  /**
   * Returns the scale within the allowed range with possible extent.
   * @param {number} s
   * @param {boolean} allowExtent
   * @return {number}
   * @private
   */
  boundScale_(s, allowExtent) {
    return boundValue(
      s,
      this.minScale_,
      this.maxScale_,
      allowExtent ? 0.25 : 0
    );
  }

  /**
   * Returns the X position within the allowed range with possible extent.
   * @param {number} x
   * @param {boolean} allowExtent
   * @return {number}
   * @private
   */
  boundX_(x, allowExtent) {
    return boundValue(
      x,
      this.minX_,
      this.maxX_,
      allowExtent && this.scale_ > 1 ? this.viewerBox_.width * 0.25 : 0
    );
  }

  /**
   * Returns the Y position within the allowed range with possible extent.
   * @param {number} y
   * @param {boolean} allowExtent
   * @return {number}
   * @private
   */
  boundY_(y, allowExtent) {
    return boundValue(
      y,
      this.minY_,
      this.maxY_,
      allowExtent ? this.viewerBox_.height * 0.25 : 0
    );
  }

  /**
   * Updates X/Y bounds based on the provided scale value. The min/max bounds
   * are calculated to allow full pan of the image regardless of the scale
   * value.
   * @param {number} scale
   * @private
   */
  updatePanZoomBounds_(scale) {
    let maxY = 0;
    let minY = 0;
    const dh = this.viewerBox_.height - this.imageBox_.height * scale;
    if (dh >= 0) {
      minY = maxY = 0;
    } else {
      minY = dh / 2;
      maxY = -minY;
    }

    let maxX = 0;
    let minX = 0;
    const dw = this.viewerBox_.width - this.imageBox_.width * scale;
    if (dw >= 0) {
      minX = maxX = 0;
    } else {
      minX = dw / 2;
      maxX = -minX;
    }

    this.minX_ = minX;
    this.minY_ = minY;
    this.maxX_ = maxX;
    this.maxY_ = maxY;
  }

  /**
   * Updates pan/zoom of the image based on the current values.
   * @private
   */
  updatePanZoom_() {
    setStyles(this.image_, {
      transform:
        st.translate(this.posX_, this.posY_) + ' ' + st.scale(this.scale_),
    });
    if (this.scale_ != 1) {
      this.lightbox_.toggleViewMode(true);
    }
  }

  /**
   * Performs a one-step or an animated motion (panning).
   * @param {number} deltaX
   * @param {number} deltaY
   * @param {boolean} animate
   * @private
   */
  onMove_(deltaX, deltaY, animate) {
    const newPosX = this.boundX_(this.startX_ + deltaX, true);
    const newPosY = this.boundY_(this.startY_ + deltaY, true);
    this.set_(this.scale_, newPosX, newPosY, animate);
  }

  /**
   * Performs actions once the motion gesture has been complete. The motion
   * may continue based on the final velocity.
   * @param {number} veloX
   * @param {number} veloY
   * @private
   */
  onMoveRelease_(veloX, veloY) {
    const deltaY = this.posY_ - this.startY_;
    if (this.scale_ == 1 && Math.abs(deltaY) > 10) {
      this.lightbox_.close();
      return;
    }

    // Continue motion.
    this.motion_ = continueMotion(
      this.image_,
      this.posX_,
      this.posY_,
      veloX,
      veloY,
      (x, y) => {
        const newPosX = this.boundX_(x, true);
        const newPosY = this.boundY_(y, true);
        if (
          Math.abs(newPosX - this.posX_) < 1 &&
          Math.abs(newPosY - this.posY_) < 1
        ) {
          // Hit the wall: stop motion.
          return false;
        }
        this.set_(this.scale_, newPosX, newPosY, false);
        return true;
      }
    );

    // Snap back.
    this.motion_.thenAlways(() => {
      this.motion_ = null;
      return this.release_();
    });
  }

  /**
   * Performs a one-step zoom action.
   * @param {number} centerClientX
   * @param {number} centerClientY
   * @param {number} deltaX
   * @param {number} deltaY
   * @private
   */
  onZoomInc_(centerClientX, centerClientY, deltaX, deltaY) {
    const dist = magnitude(deltaX, deltaY);

    const zoomSign =
      Math.abs(deltaY) > Math.abs(deltaX)
        ? Math.sign(deltaY)
        : Math.sign(-deltaX);
    if (zoomSign == 0) {
      return;
    }

    const newScale = this.startScale_ * (1 + (zoomSign * dist) / 100);
    const deltaCenterX = this.viewerBox_.width / 2 - centerClientX;
    const deltaCenterY = this.viewerBox_.height / 2 - centerClientY;
    deltaX = Math.min(deltaCenterX, deltaCenterX * (dist / 100));
    deltaY = Math.min(deltaCenterY, deltaCenterY * (dist / 100));
    this.onZoom_(newScale, deltaX, deltaY, false);
  }

  /**
   * Performs a one-step or an animated zoom action.
   * @param {number} scale
   * @param {number} deltaX
   * @param {number} deltaY
   * @param {boolean} animate
   * @return {!Promise|undefined}
   * @private
   */
  onZoom_(scale, deltaX, deltaY, animate) {
    const newScale = this.boundScale_(scale, true);
    if (newScale == this.scale_) {
      return;
    }

    this.updatePanZoomBounds_(newScale);

    const newPosX = this.boundX_(this.startX_ + deltaX * newScale, false);
    const newPosY = this.boundY_(this.startY_ + deltaY * newScale, false);
    return /** @type {!Promise|undefined} */ (
      this.set_(newScale, newPosX, newPosY, animate)
    );
  }

  /**
   * Performs actions after the gesture that was performing zooming has been
   * released. The zooming may continue based on the final velocity.
   * @param {number} centerClientX
   * @param {number} centerClientY
   * @param {number} deltaX
   * @param {number} deltaY
   * @param {number} veloX
   * @param {number} veloY
   * @return {!Promise}
   * @private
   */
  onZoomRelease_(centerClientX, centerClientY, deltaX, deltaY, veloX, veloY) {
    let promise;
    if (veloX == 0 && veloY == 0) {
      promise = Promise.resolve();
    } else {
      promise = continueMotion(
        this.image_,
        deltaX,
        deltaY,
        veloX,
        veloY,
        (x, y) => {
          this.onZoomInc_(centerClientX, centerClientY, x, y);
          return true;
        }
      ).thenAlways();
    }

    const relayout = this.scale_ > this.startScale_;
    return promise
      .then(() => {
        return this.release_();
      })
      .then(() => {
        if (relayout) {
          this.updateSrc_();
        }
      });
  }

  /**
   * Sets or animates pan/zoom parameters.
   * @param {number} newScale
   * @param {number} newPosX
   * @param {number} newPosY
   * @param {boolean} animate
   * @return {!Promise|undefined}
   * @private
   */
  set_(newScale, newPosX, newPosY, animate) {
    const ds = newScale - this.scale_;
    const dist = distance(this.posX_, this.posY_, newPosX, newPosY);

    let dur = 0;
    if (animate) {
      const maxDur = 250;
      dur = Math.min(
        maxDur,
        Math.max(
          maxDur * dist * 0.01, // Moving component.
          maxDur * Math.abs(ds)
        )
      ); // Zooming component.
    }

    let promise;
    if (dur > 16 && animate) {
      /** @const {!TransitionDef<number>} */
      const scaleFunc = tr.numeric(this.scale_, newScale);
      /** @const {!TransitionDef<number>} */
      const xFunc = tr.numeric(this.posX_, newPosX);
      /** @const {!TransitionDef<number>} */
      const yFunc = tr.numeric(this.posY_, newPosY);
      promise = Animation.animate(
        this.image_,
        (time) => {
          this.scale_ = scaleFunc(time);
          this.posX_ = xFunc(time);
          this.posY_ = yFunc(time);
          this.updatePanZoom_();
        },
        dur,
        PAN_ZOOM_CURVE_
      ).thenAlways(() => {
        this.scale_ = newScale;
        this.posX_ = newPosX;
        this.posY_ = newPosY;
        this.updatePanZoom_();
      });
    } else {
      this.scale_ = newScale;
      this.posX_ = newPosX;
      this.posY_ = newPosY;
      this.updatePanZoom_();
      if (animate) {
        promise = Promise.resolve();
      } else {
        promise = undefined;
      }
    }

    return promise;
  }

  /**
   * Sets or animates pan/zoom parameters after release of the gesture.
   * @return {!Promise}
   * @private
   */
  release_() {
    const newScale = this.boundScale_(this.scale_, false);
    if (newScale != this.scale_) {
      this.updatePanZoomBounds_(newScale);
    }
    const newPosX = this.boundX_((this.posX_ / this.scale_) * newScale, false);
    const newPosY = this.boundY_((this.posY_ / this.scale_) * newScale, false);
    return this.set_(newScale, newPosX, newPosY, true).then(() => {
      this.startScale_ = this.scale_;
      this.startX_ = this.posX_;
      this.startY_ = this.posY_;
    });
  }
}

/**
 * This class implements "amp-image-lightbox" extension element.
 */
class AmpImageLightbox extends AMP.BaseElement {
  /** @param {!AmpElement} element */
  constructor(element) {
    super(element);

    /** @private {number} */
    this.historyId_ = -1;

    /** @private {boolean} */
    this.active_ = false;

    /** @private {boolean} */
    this.entering_ = false;

    /** @private {?Element} */
    this.sourceElement_ = null;

    /** @private {?Element} */
    this.sourceImage_ = null;

    /** @private {?UnlistenDef} */
    this.unlistenViewport_ = null;

    /** @private {?Element} */
    this.container_ = null;

    /** @private {?ImageViewer} */
    this.imageViewer_ = null;

    /** @private {?Element} */
    this.captionElement_ = null;

    /** @private {!Function} */
    this.boundCloseOnEscape_ = this.closeOnEscape_.bind(this);

    this.registerDefaultAction((invocation) => this.open_(invocation), 'open');
  }

  /** @override */
  buildCallback() {
    /** If the element is in an email document, allow its `open` action. */
    Services.actionServiceForDoc(this.element).addToAllowlist(
      'AMP-IMAGE-LIGHTBOX',
      'open',
      ['email']
    );
  }

  /**
   * Lazily builds the image-lightbox DOM on the first open.
   * @private
   */
  buildLightbox_() {
    if (this.container_) {
      return;
    }

    this.container_ = this.element.ownerDocument.createElement('div');
    this.container_.classList.add('i-amphtml-image-lightbox-container');
    this.element.appendChild(this.container_);

    this.imageViewer_ = new ImageViewer(
      this,
      this.win,
      this.loadPromise.bind(this)
    );
    this.container_.appendChild(this.imageViewer_.getElement());

    this.captionElement_ = this.element.ownerDocument.createElement('div');

    // Set id to the captionElement_ for accessibility reason
    this.captionElement_.setAttribute(
      'id',
      this.element.getAttribute('id') + '-caption'
    );

    this.captionElement_.classList.add('amp-image-lightbox-caption');
    this.captionElement_.classList.add('i-amphtml-image-lightbox-caption');
    this.container_.appendChild(this.captionElement_);

    // Invisible close button at the end of lightbox for screen-readers.
    const screenReaderCloseButton =
      this.element.ownerDocument.createElement('button');
    // TODO(aghassemi, #4146) i18n
    const ariaLabel =
      this.element.getAttribute('data-close-button-aria-label') ||
      'Close the lightbox';
    screenReaderCloseButton.textContent = ariaLabel;
    screenReaderCloseButton.classList.add('i-amphtml-screen-reader');

    // This is for screen-readers only, should not get a tab stop.
    screenReaderCloseButton.tabIndex = -1;
    screenReaderCloseButton.addEventListener('click', () => {
      this.close();
    });
    this.element.appendChild(screenReaderCloseButton);

    const gestures = Gestures.get(this.element);
    this.element.addEventListener('click', (e) => {
      if (
        !this.entering_ &&
        !this.imageViewer_.getImage().contains(/** @type {?Node} */ (e.target))
      ) {
        this.close();
      }
    });
    gestures.onGesture(TapRecognizer, () => {
      if (!this.entering_) {
        this.close();
      }
    });
    gestures.onGesture(SwipeXYRecognizer, () => {
      // Consume to block scroll events and side-swipe.
    });
  }

  /**
   * @param {?../../../src/service/action-impl.ActionInvocation=} invocation
   * @private
   */
  open_(invocation) {
    if (this.active_) {
      return;
    }
    this.buildLightbox_();

    const source = invocation.caller;
    const tagName = source.tagName.toLowerCase();
    userAssert(
      source && SUPPORTED_ELEMENTS_.has(tagName),
      'Unsupported element: %s',
      source.tagName
    );

    this.active_ = true;
    this.reset_();
    this.init_(source);

    this.win.document.documentElement.addEventListener(
      'keydown',
      this.boundCloseOnEscape_
    );

    // Prepare to enter in lightbox
    this.getViewport().enterLightboxMode();

    this.enter_();

    this.unlistenViewport_ = this.getViewport().onChanged(() => {
      if (this.active_) {
        // In IOS 10.3, the measured size of an element is incorrect if the
        // element size depends on window size directly and the measurement
        // happens in window.resize event. Adding a timeout for correct
        // measurement. See https://github.com/ampproject/amphtml/issues/8479
        if (
          Services.platformFor(this.win)
            .getIosVersionString()
            .startsWith('10.3')
        ) {
          Services.timerFor(this.win).delay(() => {
            this.imageViewer_.measure();
          }, 500);
        } else {
          this.imageViewer_.measure();
        }
      }
    });

    this.getHistory_()
      .push(this.close.bind(this))
      .then((historyId) => {
        this.historyId_ = historyId;
      });
  }

  /**
   * Handles closing the lightbox when the ESC key is pressed.
   * @param {!Event} event
   * @private
   */
  closeOnEscape_(event) {
    if (event.key == Keys.ESCAPE) {
      event.preventDefault();
      this.close();
    }
  }

  /**
   * Closes the lightbox.
   */
  close() {
    if (!this.active_) {
      return;
    }
    this.active_ = false;
    this.entering_ = false;

    this.exit_();

    if (this.unlistenViewport_) {
      this.unlistenViewport_();
      this.unlistenViewport_ = null;
    }

    this.getViewport().leaveLightboxMode();
    if (this.historyId_ != -1) {
      this.getHistory_().pop(this.historyId_);
    }
    this.win.document.documentElement.removeEventListener(
      'keydown',
      this.boundCloseOnEscape_
    );
    if (this.sourceElement_) {
      dom.tryFocus(this.sourceElement_);
    }
  }

  /**
   * Toggles the view mode.
   * @param {boolean=} opt_on
   */
  toggleViewMode(opt_on) {
    if (opt_on !== undefined) {
      this.container_.classList.toggle(
        'i-amphtml-image-lightbox-view-mode',
        opt_on
      );
    } else {
      this.container_.classList.toggle('i-amphtml-image-lightbox-view-mode');
    }
  }

  /**
   * @param {!Element} sourceElement
   * @private
   */
  init_(sourceElement) {
    this.sourceElement_ = sourceElement;

    // Initialize the viewer.
    this.sourceImage_ = dom.childElementByTag(sourceElement, 'img');
    this.imageViewer_.init(this.sourceElement_, this.sourceImage_);

    // Discover caption.
    let caption = null;

    // 1. Check <figure> and <figcaption>.
    const figure = dom.closestAncestorElementBySelector(
      sourceElement,
      'figure'
    );
    if (figure) {
      caption = dom.elementByTag(figure, 'figcaption');
    }

    // 2. Check "aria-describedby".
    if (!caption) {
      const describedBy = sourceElement.getAttribute('aria-describedby');
      caption = this.element.ownerDocument.getElementById(describedBy);
    }

    if (caption) {
      dom.copyChildren(caption, dev().assertElement(this.captionElement_));
      this.imageViewer_
        .getImage()
        .setAttribute(
          'aria-describedby',
          this.captionElement_.getAttribute('id')
        );
    }

    this.captionElement_.classList.toggle('i-amphtml-empty', !caption);
  }

  /** @private */
  reset_() {
    this.imageViewer_.reset();
    dom.removeChildren(dev().assertElement(this.captionElement_));
    this.sourceElement_ = null;
    this.sourceImage_ = null;
    this.toggleViewMode(false);
  }

  /**
   * @return {!Promise}
   * @private
   */
  enter_() {
    this.entering_ = true;

    toggle(this.element, true);
    setStyles(this.element, {
      opacity: 0,
    });
    this.imageViewer_.measure();

    const anim = new Animation(this.element);
    const dur = 500;

    // Lightbox background fades in.
    anim.add(
      0,
      tr.setStyles(this.element, {
        opacity: tr.numeric(0, 1),
      }),
      0.6,
      ENTER_CURVE_
    );

    // Try to transition from the source image.
    let transLayer = null;
    if (
      this.sourceImage_ &&
      isLoaded(this.sourceImage_) &&
      this.sourceImage_.src
    ) {
      transLayer = this.element.ownerDocument.createElement('div');
      transLayer.classList.add('i-amphtml-image-lightbox-trans');
      this.getAmpDoc().getBody().appendChild(transLayer);

      const rect = layoutRectFromDomRect(
        this.sourceImage_./*OK*/ getBoundingClientRect()
      );
      const imageBox = this.imageViewer_.getImageBox();
      const clone = this.sourceImage_.cloneNode(true);
      clone.className = '';
      setStyles(clone, {
        position: 'absolute',
        top: st.px(rect.top),
        left: st.px(rect.left),
        width: st.px(rect.width),
        height: st.px(rect.height),
        transformOrigin: 'top left',
        willChange: 'transform',
      });
      transLayer.appendChild(clone);

      this.sourceImage_.classList.add('i-amphtml-ghost');

      // Move and resize the image to the location given by the lightbox.
      const dx = imageBox.left - rect.left;
      const dy = imageBox.top - rect.top;
      const scaleX = rect.width != 0 ? imageBox.width / rect.width : 1;
      // Duration will be somewhere between 0.2 and 0.8 depending on how far
      // the image needs to move.
      const motionTime = clamp((Math.abs(dy) / 250) * 0.8, 0.2, 0.8);
      anim.add(
        0,
        tr.setStyles(clone, {
          transform: tr.concat([
            tr.translate(tr.numeric(0, dx), tr.numeric(0, dy)),
            tr.scale(tr.numeric(1, scaleX)),
          ]),
        }),
        motionTime,
        ENTER_CURVE_
      );

      // Fade in the container. This will mostly affect the caption.
      setStyles(dev().assertElement(this.container_), {opacity: 0});
      anim.add(
        0.8,
        tr.setStyles(dev().assertElement(this.container_), {
          opacity: tr.numeric(0, 1),
        }),
        0.1,
        ENTER_CURVE_
      );

      // At the end, fade out the transition image.
      anim.add(
        0.9,
        tr.setStyles(transLayer, {
          opacity: tr.numeric(1, 0.01),
        }),
        0.1,
        EXIT_CURVE_
      );
    }

    return anim.start(dur).thenAlways(() => {
      this.entering_ = false;
      setStyles(this.element, {opacity: ''});
      setStyles(dev().assertElement(this.container_), {opacity: ''});
      if (transLayer) {
        this.getAmpDoc().getBody().removeChild(transLayer);
      }
    });
  }

  /**
   * @return {!Promise}
   * @private
   */
  exit_() {
    const image = this.imageViewer_.getImage();
    const imageBox = this.imageViewer_.getImageBoxWithOffset();

    const anim = new Animation(this.element);
    let dur = 500;

    // Lightbox background fades out.
    anim.add(
      0,
      tr.setStyles(this.element, {
        opacity: tr.numeric(1, 0),
      }),
      0.9,
      EXIT_CURVE_
    );

    // Try to transition to the source image.
    let transLayer = null;
    if (isLoaded(image) && image.src && this.sourceImage_) {
      transLayer = this.element.ownerDocument.createElement('div');
      transLayer.classList.add('i-amphtml-image-lightbox-trans');
      this.getAmpDoc().getBody().appendChild(transLayer);

      const rect = layoutRectFromDomRect(
        this.sourceImage_./*OK*/ getBoundingClientRect()
      );
      const clone = image.cloneNode(true);
      setStyles(clone, {
        position: 'absolute',
        top: st.px(imageBox.top),
        left: st.px(imageBox.left),
        width: st.px(imageBox.width),
        height: st.px(imageBox.height),
        transform: '',
        transformOrigin: 'top left',
        willChange: 'transform',
      });
      transLayer.appendChild(clone);

      // Fade out the container.
      anim.add(
        0,
        tr.setStyles(dev().assertElement(this.container_), {
          opacity: tr.numeric(1, 0),
        }),
        0.1,
        EXIT_CURVE_
      );

      // Move and resize the image back to where it is in the article.
      const dx = rect.left - imageBox.left;
      const dy = rect.top - imageBox.top;
      const scaleX = imageBox.width != 0 ? rect.width / imageBox.width : 1;
      /** @const {!TransitionDef<void>} */
      const moveAndScale = tr.setStyles(clone, {
        transform: tr.concat([
          tr.translate(tr.numeric(0, dx), tr.numeric(0, dy)),
          tr.scale(tr.numeric(1, scaleX)),
        ]),
      });

      // Duration will be somewhere between 0.2 and 0.8 depending on how far
      // the image needs to move. Start the motion later too, but no later
      // than 0.2.
      const motionTime = clamp((Math.abs(dy) / 250) * 0.8, 0.2, 0.8);
      anim.add(
        Math.min(0.8 - motionTime, 0.2),
        (time, complete) => {
          moveAndScale(time);
          if (complete) {
            this.sourceImage_.classList.remove('i-amphtml-ghost');
          }
        },
        motionTime,
        EXIT_CURVE_
      );

      // Fade out the transition image.
      anim.add(
        0.8,
        tr.setStyles(transLayer, {
          opacity: tr.numeric(1, 0.01),
        }),
        0.2,
        EXIT_CURVE_
      );

      // Duration will be somewhere between 300ms and 700ms depending on
      // how far the image needs to move.
      dur = clamp((Math.abs(dy) / 250) * dur, 300, dur);
    }

    return anim.start(dur).thenAlways(() => {
      if (this.sourceImage_) {
        this.sourceImage_.classList.remove('i-amphtml-ghost');
      }
      this./*OK*/ collapse();
      setStyles(this.element, {
        opacity: '',
      });
      setStyles(dev().assertElement(this.container_), {opacity: ''});
      if (transLayer) {
        this.getAmpDoc().getBody().removeChild(transLayer);
      }
      this.reset_();
    });
  }

  /**
   * @private
   * @return {!../../../src/service/history-impl.History}
   */
  getHistory_() {
    return Services.historyForDoc(this.getAmpDoc());
  }
}

AMP.extension(TAG, '0.1', (AMP) => {
  AMP.registerElement(TAG, AmpImageLightbox, CSS);
});
