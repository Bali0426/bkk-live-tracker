// Windows release módban elrejti a parancssori (konzol) ablakot, így valódi natív asztali alkalmazásként indul
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    bkk_live_tracker_lib::run();
}
