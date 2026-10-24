import { finish } from "./harness";
import { physicsTests } from "./physics";
import { cameraTests } from "./camera";
import { gameTests } from "./game";
import { envTests } from "./env";
import { stageBTests } from "./stageb";
import { speedFxTests } from "./speedfx";
physicsTests(); cameraTests(); gameTests(); envTests(); stageBTests(); speedFxTests();
finish();
