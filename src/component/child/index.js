/* @flow */
/* eslint max-lines: 0 */

import { isSameDomain, matchDomain, getDomain, type CrossDomainWindowType } from 'cross-domain-utils/src';
import { send } from 'post-robot/src';
import { ZalgoPromise } from 'zalgo-promise/src';

import { BaseComponent } from '../base';
import { getParentComponentWindow, getComponentMeta, getParentDomain, getParentRenderWindow } from '../window';
import { extend, deserializeFunctions, get, onDimensionsChange, trackDimensions, dimensionsMatchViewport, stringify,
    cycle, globalFor, getElement, documentReady, noop, stringifyError } from '../../lib';
import { POST_MESSAGE, CONTEXT_TYPES, CLOSE_REASONS, INITIAL_PROPS } from '../../constants';
import { RenderError } from '../../error';
import type { Component } from '../component';
import type { BuiltInPropsType } from '../component/props';
import type { DimensionsType } from '../../types';

import { normalizeChildProps } from './props';

export type ChildExportsType<P> = {
    updateProps : (props : (BuiltInPropsType & P)) => ZalgoPromise<void>,
    close : () => ZalgoPromise<void>
};

/*  Child Component
    ---------------

    This is the portion of code which runs inside the frame or popup window containing the component's implementation.

    When the component author calls myComponent.attach(), it creates a new instance of ChildComponent, which is then
    responsible for managing the state and messaging back up to the parent, and providing props for the component to
    utilize.
*/

export class ChildComponent<P> extends BaseComponent<P> {

    component : Component<P>
    props : BuiltInPropsType & P
    context : string

    onPropHandlers : Array<(BuiltInPropsType & P) => void>
    onInit : ZalgoPromise<ChildComponent<P>>
    watchingForResize : boolean
    autoResize : { width : boolean, height : boolean, element? : string }

    constructor(component : Component<P>) {
        super();
        this.component = component;

        if (!this.hasValidParentDomain()) {
            this.error(new RenderError(`Can not be rendered by domain: ${ this.getParentDomain() }`));
            return;
        }

        this.component.log(`construct_child`);

        // The child can specify some default props if none are passed from the parent. This often makes integrations
        // a little more seamless, as applicaiton code can call props.foo() without worrying about whether the parent
        // has provided them or not, and fall-back to some default behavior.

        this.onPropHandlers = [];

        for (let item of [ this.component, window ]) {
            for (let [ name, getter ] of [ [ 'xchild', () => this ], [ 'xprops', () => this.props ] ]) {
                // $FlowFixMe
                Object.defineProperty(item, name, {
                    configurable: true,
                    get:          () => {
                        if (!this.props) {
                            this.setProps(this.getInitialProps(), getParentDomain());
                        }
                        // $FlowFixMe
                        delete item[name];
                        // $FlowFixMe
                        item[name] = getter();
                        // $FlowFixMe
                        return item[name];
                    }
                });
            }
        }

        this.component.log(`init_child`);

        this.setWindows();

        this.listenForResize();

        // Send an init message to our parent. This gives us an initial set of data to use that we can use to function.
        //
        // For example:
        //
        // - What context are we
        // - What props has the parent specified

        this.onInit = this.sendToParent(POST_MESSAGE.INIT, {

            exports: this.exports()

        }).then(({ origin, data }) => {

            this.context = data.context;
            this.setProps(data.props, origin);

            this.watchForResize();

            return this;

        }).catch(err => {

            this.error(err);
            throw err;
        });
    }

    listenForResize() {
        if (this.component.listenForResize) {
            this.sendToParent(POST_MESSAGE.ONRESIZE, {}, { fireAndForget: true });
            window.addEventListener('resize', () => {
                this.sendToParent(POST_MESSAGE.ONRESIZE, {}, { fireAndForget: true });
            });
        }
    }

    hasValidParentDomain() : boolean {
        return matchDomain(this.component.allowedParentDomains, this.getParentDomain());
    }

    init() : ZalgoPromise<ChildComponent<P>> {
        return this.onInit;
    }

    getParentDomain() : string {
        return getParentDomain();
    }

    onProps(handler : Function) {
        this.onPropHandlers.push(handler);
    }

    getParentComponentWindow() : CrossDomainWindowType {
        return getParentComponentWindow();
    }

    getParentRenderWindow() : CrossDomainWindowType {
        return getParentRenderWindow();
    }

    getInitialProps() : (BuiltInPropsType & P) {
        let componentMeta = getComponentMeta();

        let props = componentMeta.props;

        if (props.type === INITIAL_PROPS.RAW) {
            props = props.value;
        } else if (props.type === INITIAL_PROPS.UID) {

            let parentComponentWindow = getParentComponentWindow();

            if (!isSameDomain(parentComponentWindow)) {

                if (window.location.protocol === 'file:') {
                    throw new Error(`Can not get props from file:// domain`);
                }

                throw new Error(`Parent component window is on a different domain - expected ${ getDomain() } - can not retrieve props`);
            }

            let global = globalFor(parentComponentWindow);

            if (!global) {
                throw new Error(`Can not find global for parent component - can not retrieve props`);
            }

            props = JSON.parse(global.props[componentMeta.uid]);

        } else {
            throw new Error(`Unrecognized props type: ${ props.type }`);
        }

        if (!props) {
            throw new Error(`Initial props not found`);
        }
        
        return deserializeFunctions(props, ({ fullKey, self, args }) => {
            return this.onInit.then(() => {
                let func = get(this.props, fullKey);

                if (typeof func !== 'function') {
                    throw new TypeError(`Expected ${ fullKey } to be function, got ${ typeof func }`);
                }

                return func.apply(self, args);
            });
        });
    }


    setProps(props : (BuiltInPropsType & P), origin : string, required : boolean = true) {
        // $FlowFixMe
        this.props = this.props || {};
        let normalizedProps = normalizeChildProps(this.component, props, origin, required);
        extend(this.props, normalizedProps);
        for (let handler of this.onPropHandlers) {
            handler.call(this, this.props);
        }
    }


    /*  Send to Parent
        --------------

        Send a post message to our parent window.
    */

    sendToParent(name : string, data : ?Object = {}, options : ?Object = {}) : ZalgoPromise<{ origin : string, source : CrossDomainWindowType, data : Object }> {
        let parentWindow = getParentComponentWindow();

        if (!parentWindow) {
            throw new Error(`Can not find parent component window to message`);
        }

        this.component.log(`send_to_parent_${ name }`);

        return send(parentWindow, name, data, { domain: getParentDomain(), ...options });
    }


    /*  Set Windows
        -----------

        Determine the parent window, and the parent component window. Note -- these may be different, if we were
        rendered using renderTo.
    */

    setWindows() {


        // Ensure we do not try to .attach() multiple times for the same component on the same page

        if (window.__activeZoidComponent__) {
            throw this.component.createError(`Can not attach multiple components to the same window`);
        }

        window.__activeZoidComponent__ = this;

        // Get the direct parent window

        if (!getParentComponentWindow()) {
            throw this.component.createError(`Can not find parent window`);
        }

        let componentMeta = getComponentMeta();

        if (componentMeta.tag !== this.component.tag) {
            throw this.component.createError(`Parent is ${ componentMeta.tag } - can not attach ${ this.component.tag }`);
        }

        // Note -- getting references to other windows is probably one of the hardest things to do. There's basically
        // only a few ways of doing it:
        //
        // - The window is a direct parent, in which case you can use window.parent or window.opener
        // - The window is an iframe owned by you or one of your parents, in which case you can use window.frames
        // - The window sent you a post-message, in which case you can use event.source
        //
        // If we didn't rely on winProps.parent here from the window name, we'd have to relay all of our messages through
        // our actual parent. Which is no fun at all, and pretty error prone even with the help of post-robot. So this
        // is the lesser of two evils until browsers give us something like getWindowByName(...)

        // If the parent window closes, we need to close ourselves. There's no point continuing to run our component
        // if there's no parent to message to.

        this.watchForClose();
    }

    watchForClose() {
        window.addEventListener('unload', () => this.checkClose());
    }

    enableAutoResize({ width = true, height = true } : { width : boolean, height : boolean } = {}) {
        this.autoResize = { width, height };
        this.watchForResize();
    }

    getAutoResize() : { width : boolean, height : boolean, element : HTMLElement } {

        let width = false;
        let height = false;

        let autoResize = this.autoResize || this.component.autoResize;

        if (typeof autoResize === 'object') {
            width = Boolean(autoResize.width);
            height = Boolean(autoResize.height);
        } else if (autoResize) {
            width = true;
            height = true;
        }

        let element;

        if (autoResize.element) {
            element = getElement(autoResize.element);
        } else if (window.navigator.userAgent.match(/MSIE (9|10)\./)) {
            element = document.body;
        } else {
            element = document.documentElement;
        }

        // $FlowFixMe
        return { width, height, element };
    }

    watchForResize() : ?ZalgoPromise<void> {

        let { width, height, element } = this.getAutoResize();

        if (!width && !height) {
            return;
        }

        if (this.context === CONTEXT_TYPES.POPUP) {
            return;
        }

        if (this.watchingForResize) {
            return;
        }

        this.watchingForResize = true;

        return ZalgoPromise.try(() => {

            return documentReady;

        }).then(() => {

            // $FlowFixMe
            if (!dimensionsMatchViewport(element, { width, height })) {
                // $FlowFixMe
                return this.resizeToElement(element, { width, height });
            }

        }).then(() => {

            return cycle(() => {
                return onDimensionsChange(element, { width, height }).then(() => {
                    // $FlowFixMe
                    return this.resizeToElement(element, { width, height });
                });
            });
        });
    }


    exports() : ChildExportsType<P> {

        let self = this;

        return {
            updateProps(props : (BuiltInPropsType & P)) : ZalgoPromise<void> {
                return ZalgoPromise.try(() => self.setProps(props, this.origin, false));
            },

            close() : ZalgoPromise<void> {
                return ZalgoPromise.try(() => self.destroy());
            }
        };
    }


    /*  Resize
        ------

        Resize the child window. Must be done on a user action like a click if we're in a popup
    */

    resize(width : ?number, height : ?number) : ZalgoPromise<void> {
        return ZalgoPromise.resolve().then(() => {

            this.component.log(`resize`, { width: stringify(width), height: stringify(height) });

            if (this.context === CONTEXT_TYPES.POPUP) {
                return;
            }

            return this.sendToParent(POST_MESSAGE.RESIZE, { width, height }).then(noop);
        });
    }


    resizeToElement(el : HTMLElement, { width, height } : DimensionsType) : ZalgoPromise<void> {

        let history = [];

        let resize = () => {
            return ZalgoPromise.try(() => {

                // $FlowFixMe
                let tracker = trackDimensions(el, { width, height });
                let { dimensions } = tracker.check();

                for (let size of history) {

                    let widthMatch = !width || size.width === dimensions.width;
                    let heightMatch = !height || size.height === dimensions.height;

                    if (widthMatch && heightMatch) {
                        return;
                    }
                }

                history.push({ width: dimensions.width, height: dimensions.height });

                return this.resize(width ? dimensions.width : null, height ? dimensions.height : null).then(() => {

                    if (tracker.check().changed) {
                        return resize();
                    }
                });
            });
        };

        return resize();
    }


    /*  Hide
        ----

        Hide the window and any parent template
    */

    hide() : ZalgoPromise<void> {
        return this.sendToParent(POST_MESSAGE.HIDE).then(noop);
    }

    show() : ZalgoPromise<void> {
        return this.sendToParent(POST_MESSAGE.SHOW).then(noop);
    }

    userClose() : void {
        return this.close(CLOSE_REASONS.USER_CLOSED);
    }


    /*  Close
        -----

        Close the child window
    */

    close(reason : string = CLOSE_REASONS.CHILD_CALL) {

        this.component.log(`close_child`);

        // Ask our parent window to close us

        this.sendToParent(POST_MESSAGE.CLOSE, { reason });
    }

    checkClose() {
        this.sendToParent(POST_MESSAGE.CHECK_CLOSE, {}, { fireAndForget: true });
    }


    destroy() : ZalgoPromise<void> {
        return ZalgoPromise.try(() => {
            window.close();
        });
    }


    /*  Focus
        -----

        Focus the child window. Must be done on a user action like a click
    */

    focus() {
        this.component.log(`focus`);

        window.focus();
    }


    /*  Error
        -----

        Send an error back to the parent
    */

    error(err : mixed) : ZalgoPromise<void> {

        let stringifiedError = stringifyError(err);

        this.component.logError(`error`, { error: stringifiedError });

        return this.sendToParent(POST_MESSAGE.ERROR, {
            error: stringifiedError
        }).then(noop);
    }
}
