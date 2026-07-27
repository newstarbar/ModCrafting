package com.modcrafting.observer.mixin;

import com.modcrafting.observer.InputGuard;
import net.minecraft.client.Mouse;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Mouse.class)
public class MouseMixin {
    @Inject(method = "updateMouse(D)V", at = @At("HEAD"), cancellable = true)
    private void modcrafting$blockCamera(double timeDelta, CallbackInfo ci) {
        if (InputGuard.isLocked()) {
            ci.cancel();
        }
    }

    @Inject(method = "onMouseButton(JIII)V", at = @At("HEAD"), cancellable = true)
    private void modcrafting$blockMouseButton(long window, int button, int action, int mods, CallbackInfo ci) {
        if (InputGuard.isLocked()) {
            ci.cancel();
        }
    }
}
