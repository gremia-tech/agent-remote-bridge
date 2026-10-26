// The package's own typings import the browser xterm build (and its DOM types), which would change
// fetch/WebSocket types for the whole bridge. This declares only what the plain backend uses.
import type {Terminal} from '@xterm/headless';
export class SerializeAddon {
  activate(terminal:Terminal):void;
  dispose():void;
  serialize(options?:{scrollback?:number;excludeModes?:boolean;excludeAltBuffer?:boolean;range?:{start:number;end:number}}):string;
}
