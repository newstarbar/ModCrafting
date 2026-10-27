import type { GuiLayout } from './gui-model.ts'

/** Data-only layout resources plus a small native Fabric client, isolated from handwritten initializers. */
export function generateGui(layout: GuiLayout, splitClient: boolean) {
  const [modId, name] = layout.id.split(':'), pkg = `modcrafting.generated.${modId.replaceAll('-', '_')}.gui_${name}`
  const resource = `assets/${modId}/modcrafting/gui/${name}.json`, client = pkg + '.GuiClient'
  const configName = `${modId}-gui-${name}.json`, keyName = `key.${modId}.gui.${name}`
  const source = `package ${pkg};
import com.google.gson.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.UUID;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.loader.api.FabricLoader;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper;
import net.fabricmc.fabric.api.client.rendering.v1.HudRenderCallback;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.widget.ButtonWidget;
import net.minecraft.client.render.RenderLayer;
import net.minecraft.client.gui.widget.SliderWidget;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.text.Text;
import net.minecraft.util.Identifier;
import org.slf4j.LoggerFactory;

public final class GuiClient implements ClientModInitializer {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static JsonObject layout, state = new JsonObject();
    private static final Path CONFIG = FabricLoader.getInstance().getConfigDir().resolve("${configName}");
    private static String str(JsonObject e, String key) { return e.get(key).getAsString(); }
    private static int num(JsonObject e, String key) { return e.get(key).getAsInt(); }
    private static JsonArray elements() { return layout.getAsJsonArray("elements"); }
    private static JsonObject find(String id) {
        for (JsonElement element : elements()) { JsonObject e = element.getAsJsonObject(); if (str(e, "id").equals(id)) return e; }
        return null;
    }
    private static int sliderValue(JsonObject e) {
        try { return Math.max(num(e,"min"), Math.min(num(e,"max"), state.has(str(e,"id")) ? state.get(str(e,"id")).getAsInt() : num(e,"initial"))); }
        catch (RuntimeException ignored) { return num(e,"initial"); }
    }
    private static boolean toggleValue(JsonObject e) {
        try { return state.has(str(e,"id")) ? state.get(str(e,"id")).getAsBoolean() : e.get("checked").getAsBoolean(); }
        catch (RuntimeException ignored) { return e.get("checked").getAsBoolean(); }
    }
    private static boolean hudVisible() { try { return !state.has("__visible") || state.get("__visible").getAsBoolean(); } catch (RuntimeException ignored) { return true; } }
    private static void save() {
        Path temporary = CONFIG.resolveSibling(CONFIG.getFileName() + "." + UUID.randomUUID() + ".tmp");
        try {
            Files.createDirectories(CONFIG.getParent());
            Files.writeString(temporary, GSON.toJson(state), StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW);
            try { Files.move(temporary, CONFIG, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
            catch (AtomicMoveNotSupportedException ignored) { Files.move(temporary, CONFIG, StandardCopyOption.REPLACE_EXISTING); }
        } catch (IOException error) { LoggerFactory.getLogger("${modId}").warn("Cannot save GUI configuration", error); }
        finally { try { Files.deleteIfExists(temporary); } catch (IOException ignored) {} }
    }
    private static String text(JsonObject e) {
        String label = str(e,"label"), type = str(e,"type"), binding = str(e,"bind");
        if (type.equals("toggle")) return label + ": " + (toggleValue(e) ? "ON" : "OFF");
        if (type.equals("slider")) return label + ": " + sliderValue(e);
        MinecraftClient c = MinecraftClient.getInstance();
        if (binding.equals("player-health")) return label + ": " + (c.player == null ? "-" : String.valueOf(Math.round(c.player.getHealth())));
        if (binding.equals("player-food")) return label + ": " + (c.player == null ? "-" : String.valueOf(c.player.getHungerManager().getFoodLevel()));
        JsonObject target = find(binding);
        if (target != null) return label + ": " + (str(target,"type").equals("toggle") ? (toggleValue(target) ? "ON" : "OFF") : String.valueOf(sliderValue(target)));
        return label;
    }
    private static int color(JsonObject e) { return ((int)Math.round(e.get("alpha").getAsDouble() * 255) << 24) | Integer.parseInt(str(e,"color").substring(1),16); }
    private static int ox(int width) { String anchor=str(layout,"anchor"); return anchor.endsWith("right") ? width-num(layout,"width") : anchor.equals("center") ? (width-num(layout,"width"))/2 : 0; }
    private static int oy(int height) { String anchor=str(layout,"anchor"); return anchor.startsWith("bottom") ? height-num(layout,"height") : anchor.equals("center") ? (height-num(layout,"height"))/2 : 0; }
    private static void draw(DrawContext ctx, int width, int height) {
        MinecraftClient c=MinecraftClient.getInstance(); int dx=ox(width), dy=oy(height);
        for (JsonElement element: elements()) {
            JsonObject e=element.getAsJsonObject(); int x=dx+num(e,"x"), y=dy+num(e,"y"), w=num(e,"width"), h=num(e,"height"); String type=str(e,"type");
            if(type.equals("panel")) ctx.fill(x,y,x+w,y+h,color(e));
            if(type.equals("image")) { String ref=e.has("texture")?str(e,"texture"):"minecraft:item/iron_ingot"; int split=ref.indexOf(':'); Identifier texture=Identifier.of(ref.substring(0,split),"textures/"+ref.substring(split+1)+".png"); ctx.drawTexture(RenderLayer::getGuiTextured,texture,x,y,0f,0f,w,h,w,h); }
            if(type.equals("label")) { ctx.enableScissor(x,y,x+w,y+h); ctx.drawText(c.textRenderer,text(e),x,y,color(e),e.get("shadow").getAsBoolean()); ctx.disableScissor(); }
            if(type.equals("slot")) {
                ctx.fill(x,y,x+w,y+h,0xff454545);ctx.fill(x+1,y+1,x+w-1,y+h-1,0xff8b8b8b);
                ctx.drawItem(new ItemStack(Registries.ITEM.get(Identifier.of(str(e,"itemId")))),x+(w-16)/2,y+(h-16)/2);
            }
        }
    }
    @Override public void onInitializeClient() {
        try (InputStream input=GuiClient.class.getResourceAsStream("/${resource}")) {
            if(input==null) throw new IOException("Missing GUI layout");
            layout=JsonParser.parseReader(new InputStreamReader(input,StandardCharsets.UTF_8)).getAsJsonObject();
            if(Files.isRegularFile(CONFIG)) { try(Reader reader=Files.newBufferedReader(CONFIG,StandardCharsets.UTF_8)){state=JsonParser.parseReader(reader).getAsJsonObject();} catch(Exception error){LoggerFactory.getLogger("${modId}").warn("Cannot read GUI configuration",error);} }
        } catch(IOException error) { throw new IllegalStateException(error); }
        KeyBinding key=KeyBindingHelper.registerKeyBinding(new KeyBinding("${keyName}",num(layout,"keyCode"),"key.categories.misc"));
        ClientTickEvents.END_CLIENT_TICK.register(c -> { while(key.wasPressed()) { if(c.player==null) continue;
            if(str(layout,"layoutType").equals("hud-overlay")) { state.addProperty("__visible",!hudVisible());save(); }
            else c.setScreen(c.currentScreen instanceof LayoutScreen ? null : new LayoutScreen());
        }});
        if(str(layout,"layoutType").equals("hud-overlay")) HudRenderCallback.EVENT.register((ctx,ticks) -> {
            MinecraftClient c=MinecraftClient.getInstance(); if(c.player!=null && c.currentScreen==null && !c.options.hudHidden && hudVisible()) draw(ctx,c.getWindow().getScaledWidth(),c.getWindow().getScaledHeight());
        });
    }
    private static final class LayoutScreen extends Screen {
        LayoutScreen() { super(Text.literal(str(layout,"title"))); }
        @Override public boolean shouldPause() { return false; }
        @Override protected void init() {
            for(JsonElement element:elements()) {
                JsonObject e=element.getAsJsonObject(); int x=ox(width)+num(e,"x"),y=oy(height)+num(e,"y"); String type=str(e,"type");
                if(type.equals("slider")) addDrawableChild(new BoundSlider(e,x,y));
                if(type.equals("button") || type.equals("toggle")) addDrawableChild(ButtonWidget.builder(Text.literal(text(e)),button -> {
                    if(type.equals("toggle")) { state.addProperty(str(e,"id"),!toggleValue(e));save();clearAndInit();return; }
                    String action=str(e,"action");if(action.equals("close")){close();return;}
                    if(action.equals("increment")) { JsonObject target=find(str(e,"target"));if(target!=null)state.addProperty(str(target,"id"),Math.min(num(target,"max"),sliderValue(target)+1)); }
                    if(action.equals("reset")) for(JsonElement item:elements()){JsonObject target=item.getAsJsonObject();if(str(target,"type").equals("slider"))state.addProperty(str(target,"id"),num(target,"initial"));if(str(target,"type").equals("toggle"))state.addProperty(str(target,"id"),target.get("checked").getAsBoolean());}
                    save();clearAndInit();
                }).dimensions(x,y,num(e,"width"),num(e,"height")).build());
            }
        }
        @Override public void renderBackground(DrawContext ctx,int mouseX,int mouseY,float delta) { super.renderBackground(ctx,mouseX,mouseY,delta);draw(ctx,width,height); }
    }
    private static final class BoundSlider extends SliderWidget {
        private final JsonObject element;
        BoundSlider(JsonObject e,int x,int y) { super(x,y,num(e,"width"),num(e,"height"),Text.literal(text(e)),(sliderValue(e)-num(e,"min"))/(double)(num(e,"max")-num(e,"min")));element=e; }
        @Override protected void updateMessage() { if(element!=null)setMessage(Text.literal(text(element))); }
        @Override protected void applyValue() { if(element!=null){state.addProperty(str(element,"id"),num(element,"min")+(int)Math.round(value*(num(element,"max")-num(element,"min"))));save();updateMessage();} }
    }
}
`
  return { client, keyName, configName, files: [
    { path: `${splitClient ? 'src/client/java' : 'src/main/java'}/${pkg.replaceAll('.', '/')}/GuiClient.java`, content: source },
    { path: 'src/main/resources/' + resource, content: JSON.stringify(layout, null, 2) + '\n' }
  ] }
}
